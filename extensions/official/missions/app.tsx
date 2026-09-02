import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FormEvent,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import {
  defineExtensionApp,
  type ExtensionAppActionResponse,
  type ExtensionAppAgentToolResultProps,
  type ExtensionAppPanelProps,
  type ExtensionAppView,
} from "@falcondeck/extension-sdk/app";

import {
  parseMissionPanelState,
  type MissionPanelEntry,
  type MissionPanelState,
  type MissionStatus,
} from "./model";

const PANEL_VIEW = "missions-panel";
const MISSION_CREATION_PROMPT =
  "Let’s start a FalconDeck Mission for a piece of work that may span multiple tasks or periods of waiting. Help me define a durable brief and concrete success criteria. Ask only for details that materially affect them. Include a deadline only if I choose one. Choose the least-frequent useful agent check-in cadence, asking me only if that materially affects cost or timing. Once agreed, call the FalconDeck create-mission tool. That call starts the Mission and queues its first agent check-in immediately; do not create a draft, substitute a harness goal, or merely describe a mission.";
const REQUIRED_PERMISSIONS = [
  {
    id: "threads:read",
    label: "Read task summaries",
    description:
      "Show and verify the native agent tasks linked to each Mission.",
  },
  {
    id: "agent-tools:register",
    label: "Offer Mission tools",
    description: "Let agents create, read, and update durable Mission state.",
  },
  {
    id: "automations:manage-owned",
    label: "Manage Mission check-ins",
    description:
      "Schedule and control only the Automations that belong to Missions.",
  },
] as const;

type BadgeVariant = "default" | "success" | "warning" | "danger" | "info";
type ButtonVariant = "default" | "outline" | "ghost" | "danger";

function classes(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function Button({
  className,
  variant = "default",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const variants: Record<ButtonVariant, string> = {
    default: "bg-accent text-surface-0 hover:bg-accent-strong",
    outline:
      "border border-border-emphasis bg-transparent text-fg-primary hover:bg-surface-3",
    ghost:
      "bg-transparent text-fg-secondary hover:bg-surface-3 hover:text-fg-primary",
    danger: "bg-danger text-surface-0 hover:brightness-110",
  };
  return (
    <button
      type="button"
      className={classes(
        "fd-focus inline-flex h-8 items-center justify-center rounded-[var(--fd-radius-md)] px-3 text-[length:var(--fd-text-xs)] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}

function Badge({
  variant = "default",
  children,
}: {
  variant?: BadgeVariant;
  children: ReactNode;
}) {
  const variants: Record<BadgeVariant, string> = {
    default: "bg-surface-3 text-fg-secondary",
    success: "bg-success-muted text-success",
    warning: "bg-warning-muted text-warning",
    danger: "bg-danger-muted text-danger",
    info: "bg-info-muted text-info",
  };
  return (
    <span
      className={classes(
        "inline-flex rounded-[var(--fd-radius-full)] px-2.5 py-0.5 text-[length:var(--fd-text-xs)] font-medium capitalize",
        variants[variant],
      )}
    >
      {children}
    </span>
  );
}

function Card(props: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={classes(
        "rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1",
        props.className,
      )}
    />
  );
}

function stateFromViews(
  views: readonly ExtensionAppView[],
): MissionPanelState | null {
  const view = [...views]
    .reverse()
    .find((candidate) => candidate.viewId === PANEL_VIEW && !candidate.scope);
  return view ? parseMissionPanelState(view.value) : null;
}

function stateFromResponse(
  response: ExtensionAppActionResponse,
): MissionPanelState | null {
  return stateFromViews(response.updatedViews);
}

function friendlyError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : "";
  const normalized = message.toLowerCase();
  if (
    normalized.includes("elevated_permissions_disabled") ||
    normalized.includes("elevated permission or sandbox mode") ||
    normalized.includes("elevated automations are disabled")
  ) {
    return "This check-in inherits bypass or full-access authority from its source task. Enable ‘Allow elevated automations’ in Settings → Agent Control, then choose ‘Start agent now’ again.";
  }
  if (
    normalized.includes("threads:read permission is not granted") ||
    normalized.includes("agent-tools:register permission is not granted") ||
    normalized.includes("automations:manage-owned permission is not granted")
  ) {
    return "Missions still needs permission setup. Review it in Extension settings.";
  }
  return message || "Missions could not update. Try again.";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusVariant(status: MissionStatus): BadgeVariant {
  if (status === "completed") return "success";
  if (status === "needs_human") return "danger";
  if (status === "review" || status === "waiting") return "warning";
  if (status === "active") return "info";
  return "default";
}

function statusLabel(status: MissionStatus): string {
  if (status === "active") return "In progress";
  if (status === "needs_human") return "Needs you";
  if (status === "review") return "Ready for review";
  return status.replaceAll("_", " ");
}

function SetupState({
  hasPermission,
  openExtensionSettings,
}: Pick<ExtensionAppPanelProps, "hasPermission" | "openExtensionSettings">) {
  return (
    <div className="flex min-h-full items-center justify-center overflow-y-auto px-5 py-12">
      <Card className="w-full max-w-xl p-6 shadow-[var(--fd-shadow-lg)]">
        <Badge variant="warning">Setup required</Badge>
        <h2 className="mt-3 text-[length:var(--fd-text-lg)] font-semibold text-fg-primary">
          Finish setting up Missions
        </h2>
        <p className="mt-1.5 text-[length:var(--fd-text-sm)] leading-relaxed text-fg-secondary">
          Missions is off by default. Grant these capabilities before agents can
          create or update Mission projects.
        </p>
        <div className="mt-5 divide-y divide-border-default rounded-[var(--fd-radius-lg)] border border-border-default">
          {REQUIRED_PERMISSIONS.map((permission) => {
            const granted = hasPermission(permission.id);
            return (
              <div key={permission.id} className="flex gap-3 px-4 py-3.5">
                <span
                  className={classes(
                    "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[length:var(--fd-text-xs)] font-semibold",
                    granted
                      ? "bg-success-muted text-success"
                      : "border border-border-emphasis text-fg-tertiary",
                  )}
                >
                  {granted ? "✓" : ""}
                </span>
                <div>
                  <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                    {permission.label}
                  </p>
                  <p className="mt-0.5 text-[length:var(--fd-text-xs)] leading-relaxed text-fg-tertiary">
                    {permission.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
        {openExtensionSettings ? (
          <Button className="mt-5" onClick={openExtensionSettings}>
            Open Extension settings
          </Button>
        ) : null}
      </Card>
    </div>
  );
}

function StatusActions({
  mission,
  pending,
  act,
}: {
  mission: MissionPanelEntry;
  pending: boolean;
  act(status: MissionStatus): void;
}) {
  if (mission.status === "completed" || mission.status === "cancelled")
    return null;
  return (
    <>
      {mission.status === "paused" ? (
        <Button
          disabled={pending}
          variant="outline"
          onClick={() => act("active")}
        >
          Reactivate
        </Button>
      ) : (
        <Button
          disabled={pending}
          variant="outline"
          onClick={() => act("paused")}
        >
          Pause
        </Button>
      )}
      {mission.status === "review" ? (
        <Button disabled={pending} onClick={() => act("completed")}>
          Accept completion
        </Button>
      ) : null}
      <Button
        disabled={pending}
        variant="ghost"
        onClick={() => act("cancelled")}
      >
        Cancel
      </Button>
    </>
  );
}

function MissionCard({
  mission,
  busy,
  invoke,
  openThread,
}: {
  mission: MissionPanelEntry;
  busy: boolean;
  invoke(actionId: string, input: unknown): Promise<boolean>;
  openThread(workspaceId: string, threadId: string): void;
}) {
  const [message, setMessage] = useState("");
  const [runNow, setRunNow] = useState(false);
  const [cadenceDays, setCadenceDays] = useState("7");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!message.trim()) return;
    void invoke("add-mission-update", {
      missionId: mission.id,
      body: message,
      runNow,
    }).then((updated) => {
      if (updated) {
        setMessage("");
        setRunNow(false);
      }
    });
  };

  const setStatus = (status: MissionStatus) => {
    void invoke("set-mission-status", { missionId: mission.id, status });
  };

  return (
    <Card className="overflow-hidden">
      <div className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[length:var(--fd-text-base)] font-semibold text-fg-primary">
              {mission.title}
            </h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[length:var(--fd-text-xs)] text-fg-tertiary">
              <Badge variant={statusVariant(mission.status)}>
                {statusLabel(mission.status)}
              </Badge>
              {mission.deadline ? (
                <span>Deadline {formatDate(mission.deadline)}</span>
              ) : (
                <span>No deadline</span>
              )}
              <span>
                {mission.threads.length} linked{" "}
                {mission.threads.length === 1 ? "task" : "tasks"}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <StatusActions mission={mission} pending={busy} act={setStatus} />
          </div>
        </div>

        <p className="mt-4 whitespace-pre-wrap text-[length:var(--fd-text-sm)] leading-relaxed text-fg-secondary">
          {mission.brief}
        </p>

        {mission.successCriteria.length > 0 ? (
          <div className="mt-4">
            <p className="text-[length:var(--fd-text-xs)] font-medium uppercase tracking-wide text-fg-tertiary">
              Success criteria
            </p>
            <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[length:var(--fd-text-xs)] leading-relaxed text-fg-secondary">
              {mission.successCriteria.map((criterion, index) => (
                <li key={`${mission.id}:criterion:${index}`}>{criterion}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {mission.updates.length > 0 ? (
          <div className="mt-4 rounded-[var(--fd-radius-lg)] bg-surface-2 px-4 py-3">
            <p className="text-[length:var(--fd-text-xs)] font-medium uppercase tracking-wide text-fg-tertiary">
              Recent updates
            </p>
            <div className="mt-2 space-y-2.5">
              {[...mission.updates].reverse().map((update) => (
                <div
                  key={update.id}
                  className="text-[length:var(--fd-text-xs)] leading-relaxed"
                >
                  <div className="flex flex-wrap gap-2 text-fg-tertiary">
                    <span className="capitalize">
                      {update.actor} · {update.kind}
                    </span>
                    <span>{formatDate(update.createdAt)}</span>
                  </div>
                  <p className="mt-0.5 text-fg-secondary">{update.body}</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {mission.threads.length > 0 ? (
          <div className="mt-4">
            <p className="text-[length:var(--fd-text-xs)] font-medium uppercase tracking-wide text-fg-tertiary">
              Linked tasks
            </p>
            <div className="mt-1.5 divide-y divide-border-default overflow-hidden rounded-[var(--fd-radius-md)] border border-border-default">
              {mission.threads.map((thread) => (
                <button
                  key={`${thread.workspaceId}:${thread.threadId}`}
                  type="button"
                  onClick={() =>
                    openThread(thread.workspaceId, thread.threadId)
                  }
                  className="fd-focus flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-surface-2"
                >
                  <span className="min-w-0 truncate text-[length:var(--fd-text-xs)] text-fg-secondary">
                    {thread.title}
                  </span>
                  <span className="shrink-0 text-[length:var(--fd-text-xs)] capitalize text-fg-tertiary">
                    {thread.provider} · {thread.role}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-4">
          <p className="text-[length:var(--fd-text-xs)] font-medium uppercase tracking-wide text-fg-tertiary">
            Agent check-ins
          </p>
          {mission.automations.length > 0 ? (
            <div className="mt-1.5 space-y-2">
              {mission.automations.map((automation) => (
                <div
                  key={automation.id}
                  className="rounded-[var(--fd-radius-md)] border border-border-default px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[length:var(--fd-text-xs)] font-medium text-fg-secondary">
                      {automation.resolvedSchedule}
                    </span>
                    <Badge
                      variant={
                        automation.state === "enabled" ? "success" : "default"
                      }
                    >
                      {automation.state}
                    </Badge>
                    <span className="text-[length:var(--fd-text-xs)] capitalize text-fg-tertiary">
                      {automation.provider}
                    </span>
                    <span className="ml-auto flex gap-1.5">
                      <Button
                        variant="outline"
                        disabled={
                          busy ||
                          automation.state !== "enabled" ||
                          ["paused", "completed", "cancelled"].includes(
                            mission.status,
                          )
                        }
                        onClick={() =>
                          void invoke("run-mission-review", {
                            missionId: mission.id,
                          })
                        }
                      >
                        Run agent now
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={
                          busy ||
                          (automation.state !== "enabled" &&
                            ["paused", "completed", "cancelled"].includes(
                              mission.status,
                            ))
                        }
                        onClick={() =>
                          void invoke("control-mission-automation", {
                            missionId: mission.id,
                            operation:
                              automation.state === "enabled"
                                ? "pause"
                                : "resume",
                          })
                        }
                      >
                        {automation.state === "enabled" ? "Pause" : "Resume"}
                      </Button>
                    </span>
                  </div>
                  <p className="mt-1 text-[length:var(--fd-text-xs)] text-fg-tertiary">
                    {automation.nextRunAt
                      ? `Next check-in ${formatDate(automation.nextRunAt)}`
                      : "No scheduled check-in"}
                    {automation.latestOutcome
                      ? ` · Last ${automation.latestOutcome.status} ${formatDate(
                          automation.latestOutcome.finishedAt,
                        )}`
                      : " · First agent run queued"}
                  </p>
                </div>
              ))}
            </div>
          ) : !["paused", "completed", "cancelled"].includes(mission.status) ? (
            <div className="mt-1.5 rounded-[var(--fd-radius-lg)] border border-warning bg-warning-muted px-4 py-3">
              <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                No agent has started
              </p>
              <p className="mt-1 text-[length:var(--fd-text-xs)] leading-relaxed text-fg-secondary">
                This Mission is saved, but it will stay idle until an agent
                check-in is started.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-[length:var(--fd-text-xs)] text-fg-secondary">
                  Start now, then check again every
                </span>
                <select
                  aria-label={`Check-in cadence for ${mission.title}`}
                  value={cadenceDays}
                  onChange={(event) => setCadenceDays(event.target.value)}
                  className="fd-focus h-8 rounded-[var(--fd-radius-md)] border border-border-default bg-surface-1 px-2 text-[length:var(--fd-text-xs)] text-fg-primary"
                >
                  <option value="1">day</option>
                  <option value="7">week</option>
                  <option value="30">30 days</option>
                </select>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void invoke("schedule-mission-review", {
                      missionId: mission.id,
                      cadenceDays: Number(cadenceDays),
                      runImmediately: true,
                    })
                  }
                >
                  Start agent now
                </Button>
              </div>
              <p className="mt-2 text-[length:var(--fd-text-xs)] text-fg-tertiary">
                Uses the source task&apos;s provider, model, and authority
                settings.
              </p>
            </div>
          ) : (
            <p className="mt-1.5 text-[length:var(--fd-text-xs)] text-fg-tertiary">
              Agent check-ins are paused with this Mission.
            </p>
          )}
        </div>
      </div>

      {mission.status !== "completed" && mission.status !== "cancelled" ? (
        <form
          onSubmit={submit}
          className="border-t border-border-default bg-surface-2 px-5 py-4"
        >
          <label
            className="text-[length:var(--fd-text-xs)] font-medium text-fg-secondary"
            htmlFor={`message-${mission.id}`}
          >
            Message Mission
          </label>
          <div className="mt-1.5 flex gap-2">
            <input
              id={`message-${mission.id}`}
              value={message}
              maxLength={1_000}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Add guidance, a decision, or context for the next review"
              className="fd-focus h-9 min-w-0 flex-1 rounded-[var(--fd-radius-md)] border border-border-default bg-surface-1 px-3 text-[length:var(--fd-text-sm)] text-fg-primary placeholder:text-fg-tertiary"
            />
            <Button disabled={busy || !message.trim()} type="submit">
              Post update
            </Button>
          </div>
          {mission.automations.some(
            (automation) => automation.state === "enabled",
          ) ? (
            <label className="mt-2 flex items-center gap-2 text-[length:var(--fd-text-xs)] text-fg-tertiary">
              <input
                type="checkbox"
                checked={runNow}
                onChange={(event) => setRunNow(event.target.checked)}
              />
              Ask the Mission to review this update now
            </label>
          ) : null}
        </form>
      ) : null}
    </Card>
  );
}

function MissionDashboard({
  views,
  hasPermission,
  invokeAction,
  openThread,
  startTask,
  openExtensionSettings,
}: ExtensionAppPanelProps) {
  const ready = REQUIRED_PERMISSIONS.every((permission) =>
    hasPermission(permission.id),
  );
  const [state, setState] = useState<MissionPanelState | null>(() =>
    stateFromViews(views),
  );
  const [loading, setLoading] = useState(ready && !state);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialLoad = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await invokeAction("refresh-missions", {});
      const next = stateFromResponse(response);
      if (!next) throw new Error("Missions returned an invalid view");
      setState(next);
      setError(null);
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setLoading(false);
    }
  }, [invokeAction]);

  const invoke = useCallback(
    async (actionId: string, input: unknown): Promise<boolean> => {
      setBusy(true);
      try {
        const response = await invokeAction(actionId, input);
        const next = stateFromResponse(response);
        if (next) setState(next);
        else await refresh();
        setError(null);
        return true;
      } catch (reason) {
        setError(friendlyError(reason));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [invokeAction, refresh],
  );

  useEffect(() => {
    const published = stateFromViews(views);
    if (published) setState(published);
  }, [views]);

  useEffect(() => {
    if (!ready || initialLoad.current) return;
    initialLoad.current = true;
    void refresh();
  }, [ready, refresh]);

  if (!ready) {
    return (
      <SetupState
        hasPermission={hasPermission}
        openExtensionSettings={openExtensionSettings}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-5 py-7 sm:px-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <p className="text-[length:var(--fd-text-sm)] leading-relaxed text-fg-secondary">
              Missions keep larger outcomes visible when the work spans several
              agent tasks or long periods of waiting. Each Mission holds the
              durable brief, success criteria, decisions, evidence, and linked
              tasks; native Goals do the focused work and optional Automations
              wake an agent for future check-ins.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              disabled={!startTask}
              onClick={() => startTask?.(MISSION_CREATION_PROMPT)}
            >
              New mission
            </Button>
            <Button
              variant="outline"
              disabled={loading}
              onClick={() => void refresh()}
            >
              Refresh
            </Button>
          </div>
        </div>

        {error ? (
          <p
            role="alert"
            className="mt-4 text-[length:var(--fd-text-xs)] text-danger"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-7 space-y-4">
          {loading && !state ? (
            <Card className="p-8 text-center text-[length:var(--fd-text-sm)] text-fg-tertiary">
              Loading Missions…
            </Card>
          ) : state?.missions.length ? (
            state.missions.map((mission) => (
              <MissionCard
                key={mission.id}
                mission={mission}
                busy={busy}
                invoke={invoke}
                openThread={openThread}
              />
            ))
          ) : (
            <Card className="p-8 text-center">
              <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                No Missions yet
              </p>
              <p className="mx-auto mt-1 max-w-lg text-[length:var(--fd-text-xs)] leading-relaxed text-fg-tertiary">
                Start one when work needs a durable home above a single agent
                task—not simply because the task is difficult.
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function MissionStartedToolResult({
  result,
  views,
  presentation,
  openDetails,
}: ExtensionAppAgentToolResultProps) {
  const envelope =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : null;
  const inner =
    envelope?.result &&
    typeof envelope.result === "object" &&
    !Array.isArray(envelope.result)
      ? (envelope.result as Record<string, unknown>)
      : envelope;
  const missionId =
    typeof inner?.missionId === "string" ? inner.missionId : null;
  const mission = missionId
    ? stateFromViews(views)?.missions.find(
        (candidate) => candidate.id === missionId,
      )
    : null;
  const checkInDays =
    typeof inner?.checkInDays === "number" ? inner.checkInDays : null;
  const detailed = presentation === "detail";

  if (!missionId) return null;

  return (
    <Card
      className={classes(detailed ? "border-0 bg-transparent p-0" : "my-3 p-4")}
    >
      <div className="flex items-center justify-between gap-3">
        <Badge variant="info">Started</Badge>
        {!detailed && openDetails ? (
          <Button variant="ghost" onClick={openDetails}>
            Open details
          </Button>
        ) : null}
      </div>
      <h3 className="mt-2 text-[length:var(--fd-text-sm)] font-semibold text-fg-primary">
        Mission started
      </h3>
      <p className="mt-1 text-[length:var(--fd-text-xs)] leading-relaxed text-fg-secondary">
        An agent check-in is queued now
        {checkInDays
          ? `, with future check-ins every ${checkInDays} ${checkInDays === 1 ? "day" : "days"}`
          : ""}
        . You can leave this task; the Mission will keep its brief and progress.
      </p>
      {mission ? (
        <>
          <p className="mt-1 text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
            {mission.title}
          </p>
          <p
            className={classes(
              "mt-1 whitespace-pre-wrap text-[length:var(--fd-text-xs)] leading-relaxed text-fg-secondary",
              !detailed && "line-clamp-4",
            )}
          >
            {mission.brief}
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[length:var(--fd-text-xs)] text-fg-secondary">
            {mission.successCriteria
              .slice(0, detailed ? mission.successCriteria.length : 3)
              .map((criterion, index) => (
                <li
                  className={detailed ? undefined : "line-clamp-2"}
                  key={index}
                >
                  {criterion}
                </li>
              ))}
          </ul>
          {!detailed && mission.successCriteria.length > 3 ? (
            <p className="mt-1 text-[length:var(--fd-text-xs)] text-fg-tertiary">
              +{mission.successCriteria.length - 3} more criteria
            </p>
          ) : null}
          <p className="mt-2 text-[length:var(--fd-text-xs)] text-fg-tertiary">
            {mission.deadline
              ? `Deadline ${formatDate(mission.deadline)}`
              : "No deadline"}
          </p>
        </>
      ) : null}
    </Card>
  );
}

export default defineExtensionApp("falcondeck.missions", (app) => {
  app.panels.register({
    id: "missions",
    title: "Missions",
    icon: "activity",
    component: MissionDashboard,
  });
  app.agentToolResults.register({
    toolId: "create-mission",
    component: MissionStartedToolResult,
    detail: { title: "Mission" },
  });
});
