import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
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
  type MissionPanelRun,
  type MissionPanelState,
} from "./model";

const PANEL_VIEW = "missions-panel";
const AUTONOMOUS_ACCESS_LABEL = "Full access · Never ask";
const MISSION_CREATION_PROMPT =
  "Let’s set up a FalconDeck Mission together. Help me define the objective, acceptance criteria, and sensible limits for time, coordinator turns, and workers. Ask only for details that materially affect the plan. Once we’ve agreed, use the FalconDeck Mission tools to create a draft for my review, passing the agreed limits in the structured leaseMinutes, maxAutomaticTurns, and maxWorkers fields rather than only writing them in the objective. Do not begin the work until I start the Mission.";
const REQUIRED_PERMISSIONS = [
  {
    id: "threads:read",
    label: "Read tasks",
    description: "Find an existing task that can coordinate the work.",
  },
  {
    id: "agent-tools:register",
    label: "Agent tools",
    description: "Let coordinators checkpoint progress and delegate workers.",
  },
  {
    id: "orchestration:manage-owned-tasks",
    label: "Manage owned tasks",
    description: "Continue and pause only work owned by this Mission.",
  },
] as const;

type BadgeVariant = "default" | "success" | "warning" | "danger" | "info";
type ButtonVariant = "default" | "outline" | "ghost" | "danger";
type ButtonSize = "default" | "sm";

function classes(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const variants: Record<ButtonVariant, string> = {
    default:
      "bg-accent text-surface-0 shadow-[var(--fd-shadow-sm)] hover:bg-accent-strong",
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
        "fd-focus inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
        size === "sm"
          ? "h-7 rounded-[var(--fd-radius-md)] px-2.5 text-[length:var(--fd-text-xs)]"
          : "h-9 rounded-[var(--fd-radius-lg)] px-3.5 text-[length:var(--fd-text-sm)]",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}

function Badge({
  className,
  variant = "default",
  dot,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  variant?: BadgeVariant;
  dot?: boolean;
}) {
  const variants: Record<BadgeVariant, string> = {
    default: "bg-surface-3 text-fg-secondary",
    success: "bg-success-muted text-success",
    warning: "bg-warning-muted text-warning",
    danger: "bg-danger-muted text-danger",
    info: "bg-info-muted text-info",
  };
  const dots: Record<BadgeVariant, string> = {
    default: "bg-fg-tertiary",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    info: "bg-info",
  };
  return (
    <div
      className={classes(
        "inline-flex items-center gap-1.5 rounded-[var(--fd-radius-full)] px-2.5 py-0.5 text-[length:var(--fd-text-xs)] font-medium",
        variants[variant],
        className,
      )}
      {...props}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className={classes("h-1.5 w-1.5 rounded-full", dots[variant])}
        />
      ) : null}
      {children}
    </div>
  );
}

function Card({
  className,
  variant = "flat",
  ...props
}: HTMLAttributes<HTMLDivElement> & { variant?: "flat" | "elevated" }) {
  return (
    <div
      className={classes(
        "rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1",
        variant === "elevated" &&
          "bg-surface-2 shadow-[var(--fd-shadow-lg)]",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={classes("flex flex-col gap-2 p-5 pb-3", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={classes("px-5 pb-5", className)} {...props} />;
}

function CardTitle({
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={classes(
        "text-[length:var(--fd-text-lg)] font-semibold tracking-tight text-fg-primary",
        className,
      )}
      {...props}
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
  if (message.toLowerCase().includes("permission")) {
    return "Missions still needs permission setup. Review its permissions in Extension settings.";
  }
  return message || "Missions could not update. Try again.";
}

function formatDeadline(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No valid deadline";
  return date.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} hr` : `${hours.toFixed(1)} hr`;
}

function statusVariant(run: MissionPanelRun): BadgeVariant {
  if (run.outcome === "completed") return "success";
  if (run.hasUnknownOutcome) return "danger";
  if (run.gate === "paused") return "warning";
  if (run.gate === "open") return "info";
  return "default";
}

function SetupState({
  hasPermission,
  openExtensionSettings,
}: Pick<
  ExtensionAppPanelProps,
  "hasPermission" | "openExtensionSettings"
>) {
  return (
    <div className="flex min-h-full items-start justify-center overflow-y-auto px-5 py-10 sm:items-center sm:py-14">
      <Card className="w-full max-w-xl" variant="elevated">
        <CardHeader className="gap-3 border-b border-border-default pb-5">
          <Badge className="w-fit" variant="warning" dot>
            Setup required
          </Badge>
          <div className="space-y-1.5">
            <CardTitle>Finish setting up Missions</CardTitle>
            <p className="max-w-lg text-[length:var(--fd-text-sm)] leading-relaxed text-fg-secondary">
              Missions is intentionally off by default. Grant these three
              capabilities before a coordinator can start or manage work.
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          <div className="divide-y divide-border-default rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-1">
            {REQUIRED_PERMISSIONS.map((permission) => {
              const granted = hasPermission(permission.id);
              return (
                <div
                  key={permission.id}
                  className="flex items-start gap-3 px-4 py-3.5"
                >
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[length:var(--fd-text-xs)] font-semibold ${
                      granted
                        ? "bg-success-muted text-success"
                        : "border border-border-emphasis bg-surface-2 text-fg-tertiary"
                    }`}
                  >
                    {granted ? "✓" : ""}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                        {permission.label}
                      </p>
                      <span
                        className={`text-[length:var(--fd-text-xs)] font-medium ${
                          granted ? "text-success" : "text-fg-tertiary"
                        }`}
                      >
                        {granted ? "Granted" : "Required"}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[length:var(--fd-text-xs)] leading-relaxed text-fg-tertiary">
                      {permission.description}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
          {openExtensionSettings ? (
            <Button className="w-full sm:w-auto" onClick={openExtensionSettings}>
              Open Extension settings
            </Button>
          ) : (
            <p className="text-[length:var(--fd-text-sm)] text-fg-secondary">
              Open Extension settings and select Missions to grant access.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-1 px-4 py-3">
      <p className="text-[length:var(--fd-text-xl)] font-semibold tabular-nums text-fg-primary">
        {value}
      </p>
      <p className="mt-0.5 text-[length:var(--fd-text-xs)] text-fg-tertiary">
        {label}
      </p>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`missions-${title.toLowerCase().replaceAll(" ", "-")}`}>
      <div className="mb-3">
        <h2
          id={`missions-${title.toLowerCase().replaceAll(" ", "-")}`}
          className="text-[length:var(--fd-text-base)] font-semibold text-fg-primary"
        >
          {title}
        </h2>
        <p className="mt-0.5 text-[length:var(--fd-text-xs)] text-fg-tertiary">
          {description}
        </p>
      </div>
      {children}
    </section>
  );
}

function EmptySection({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[var(--fd-radius-lg)] border border-dashed border-border-emphasis px-4 py-6 text-center text-[length:var(--fd-text-sm)] text-fg-tertiary">
      {children}
    </div>
  );
}

function RunActions({
  run,
  pending,
  act,
}: {
  run: MissionPanelRun;
  pending: string | null;
  act(actionId: string, input: unknown, pendingKey: string): void;
}) {
  if (run.gate === "closed") return null;
  const input = {
    runId: run.id,
    expectedPolicyRevision: run.policyRevision,
  };
  const button = (
    actionId: string,
    label: string,
    variant: ButtonVariant = "outline",
  ) => {
    const key = `${run.id}:${actionId}`;
    return (
      <Button
        key={actionId}
        size="sm"
        variant={variant}
        disabled={pending !== null}
        onClick={() => act(actionId, input, key)}
      >
        {pending === key ? "Working…" : label}
      </Button>
    );
  };

  if (run.hasUnknownOutcome) {
    return button("close-incomplete", "Close incomplete", "danger");
  }
  if (run.completionProposed && run.gate === "paused") {
    return (
      <>
        {button("accept-completion", "Accept completion", "default")}
        {button("close-incomplete", "Close incomplete", "danger")}
      </>
    );
  }
  if (run.gate === "paused" && run.coordinatorSettling) {
    return (
      <>
        {button("extend-run", "Extend 1 hour")}
        {button("close-incomplete", "Close incomplete", "danger")}
      </>
    );
  }
  return (
    <>
      {run.gate === "open"
        ? button("pause-run", "Pause")
        : button("resume-run", "Resume", "default")}
      {button("extend-run", "Extend 1 hour")}
      {button("close-incomplete", "Close incomplete", "danger")}
    </>
  );
}

function RunCard({
  run,
  pending,
  act,
  openThread,
}: {
  run: MissionPanelRun;
  pending: string | null;
  act(actionId: string, input: unknown, pendingKey: string): void;
  openThread(workspaceId: string, threadId: string): void;
}) {
  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <CardTitle className="text-[length:var(--fd-text-base)]">
              {run.title}
            </CardTitle>
            <p className="mt-1 text-[length:var(--fd-text-sm)] leading-relaxed text-fg-secondary">
              {run.objective}
            </p>
          </div>
          <Badge variant={statusVariant(run)} dot>
            {run.status}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--fd-text-xs)] text-fg-tertiary">
          <span>
            {run.automaticTurnsStarted}/{run.maxAutomaticTurns} automatic turns
          </span>
          <span>
            {run.workers.length}/{run.maxWorkers} workers
          </span>
          <span>Due {formatDeadline(run.deadlineAt)}</span>
          <span>{AUTONOMOUS_ACCESS_LABEL}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {run.checkpoint.summary ? (
          <div className="rounded-[var(--fd-radius-md)] bg-surface-2 px-3.5 py-3">
            <p className="text-[length:var(--fd-text-xs)] font-medium uppercase tracking-wide text-fg-tertiary">
              Latest checkpoint
            </p>
            <p className="mt-1 text-[length:var(--fd-text-sm)] leading-relaxed text-fg-secondary">
              {run.checkpoint.summary}
            </p>
          </div>
        ) : null}
        {run.checkpoint.nextAction ? (
          <p className="text-[length:var(--fd-text-sm)] leading-relaxed text-fg-secondary">
            <span className="font-medium text-fg-primary">Next: </span>
            {run.checkpoint.nextAction}
          </p>
        ) : null}
        {run.checkpoint.evidence.length > 0 ||
        run.checkpoint.limitations.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {run.checkpoint.evidence.length > 0 ? (
              <div>
                <p className="text-[length:var(--fd-text-xs)] font-medium uppercase tracking-wide text-fg-tertiary">
                  Evidence
                </p>
                <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[length:var(--fd-text-xs)] leading-relaxed text-fg-secondary">
                  {run.checkpoint.evidence.map((item, index) => (
                    <li key={`${run.id}:evidence:${index}`}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {run.checkpoint.limitations.length > 0 ? (
              <div>
                <p className="text-[length:var(--fd-text-xs)] font-medium uppercase tracking-wide text-fg-tertiary">
                  Limitations
                </p>
                <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[length:var(--fd-text-xs)] leading-relaxed text-fg-secondary">
                  {run.checkpoint.limitations.map((item, index) => (
                    <li key={`${run.id}:limitation:${index}`}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
        {run.pauseReason || run.checkpoint.humanQuestion ? (
          <div className="rounded-[var(--fd-radius-md)] border border-warning/25 bg-warning-muted px-3.5 py-3 text-[length:var(--fd-text-sm)] leading-relaxed text-warning">
            {run.checkpoint.humanQuestion ?? run.pauseReason}
          </div>
        ) : null}
        {run.hasUnknownOutcome ? (
          <p className="text-[length:var(--fd-text-xs)] leading-relaxed text-danger">
            A provider operation has an unknown outcome. FalconDeck will not
            retry it automatically; review the related tasks before closing.
          </p>
        ) : null}
        {run.workers.length > 0 ? (
          <div className="space-y-2">
            <p className="text-[length:var(--fd-text-xs)] font-medium uppercase tracking-wide text-fg-tertiary">
              Workers
            </p>
            <div className="divide-y divide-border-default rounded-[var(--fd-radius-md)] border border-border-default">
              {run.workers.map((worker) => (
                <button
                  key={worker.id}
                  type="button"
                  disabled={!worker.threadId}
                  onClick={() =>
                    worker.threadId &&
                    openThread(run.workspaceId, worker.threadId)
                  }
                  className="fd-focus flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[length:var(--fd-text-xs)] enabled:hover:bg-surface-2 disabled:cursor-default"
                >
                  <span className="truncate capitalize text-fg-secondary">
                    {worker.provider} · {worker.id.slice(0, 8)}
                  </span>
                  <span className="shrink-0 capitalize text-fg-tertiary">
                    {worker.status.replaceAll("_", " ")}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-default pt-4">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              openThread(run.workspaceId, run.coordinatorThreadId)
            }
          >
            Open coordinator
          </Button>
          <div className="flex flex-wrap justify-end gap-2">
            <RunActions run={run} pending={pending} act={act} />
          </div>
        </div>
      </CardContent>
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
  const [loading, setLoading] = useState(ready);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const initialLoadStarted = useRef(false);

  const refresh = useCallback(
    async (showLoading = true) => {
      if (showLoading) setLoading(true);
      try {
        const response = await invokeAction("refresh-missions", {});
        const next = stateFromResponse(response);
        if (!next) {
          setError("Missions returned an invalid update. Try again.");
          return;
        }
        setState(next);
        setError(null);
      } catch (reason) {
        setError(friendlyError(reason));
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [invokeAction],
  );

  useEffect(() => {
    const published = stateFromViews(views);
    if (published) setState(published);
  }, [views]);

  useEffect(() => {
    if (!ready) {
      initialLoadStarted.current = false;
      setLoading(false);
      return;
    }
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    void refresh();
  }, [ready, refresh]);

  const act = useCallback(
    async (actionId: string, input: unknown, pendingKey: string) => {
      setPending(pendingKey);
      setError(null);
      try {
        const response = await invokeAction(actionId, input);
        const next = stateFromResponse(response);
        if (next) setState(next);
        await refresh(false);
      } catch (reason) {
        setError(friendlyError(reason));
      } finally {
        setPending(null);
      }
    },
    [invokeAction, refresh],
  );

  const activeRuns = useMemo(
    () => state?.runs.filter((run) => run.gate !== "closed").length ?? 0,
    [state],
  );

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
      <div className="mx-auto w-full max-w-5xl space-y-8 px-5 py-6 sm:px-7 sm:py-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <p className="text-[length:var(--fd-text-sm)] leading-relaxed text-fg-secondary">
              Coordinate bounded work from an agent task while FalconDeck
              enforces the deadline, turn limit, and worker limit.
            </p>
            <p className="mt-1 text-[length:var(--fd-text-xs)] leading-relaxed text-fg-tertiary">
              Mission coordinator and worker turns use {AUTONOMOUS_ACCESS_LABEL}
              so long-running work does not stop for routine tool approvals.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={!startTask}
              title={
                startTask
                  ? undefined
                  : "Select a project to start a new Mission."
              }
              onClick={() => startTask?.(MISSION_CREATION_PROMPT)}
            >
              New mission
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={loading || pending !== null}
              onClick={() => void refresh()}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat value={activeRuns} label="Open missions" />
          <Stat value={state?.drafts.length ?? 0} label="Drafts to review" />
          <Stat value={state?.candidates.length ?? 0} label="Available tasks" />
        </div>

        {error ? (
          <div
            role="alert"
            className="rounded-[var(--fd-radius-lg)] border border-danger/25 bg-danger-muted px-4 py-3 text-[length:var(--fd-text-sm)] text-danger"
          >
            {error}
          </div>
        ) : null}
        {state?.notice ? (
          <div className="rounded-[var(--fd-radius-lg)] border border-info/25 bg-info-muted px-4 py-3 text-[length:var(--fd-text-sm)] text-info">
            {state.notice}
          </div>
        ) : null}

        {loading && !state ? (
          <div className="py-16 text-center text-[length:var(--fd-text-sm)] text-fg-tertiary">
            Loading Missions…
          </div>
        ) : (
          <>
            <Section
              title="Mission runs"
              description="Review progress and control every active or recently closed mission."
            >
              {state?.runs.length ? (
                <div className="space-y-3">
                  {state.runs.map((run) => (
                    <RunCard
                      key={run.id}
                      run={run}
                      pending={pending}
                      act={(actionId, input, pendingKey) =>
                        void act(actionId, input, pendingKey)
                      }
                      openThread={openThread}
                    />
                  ))}
                </div>
              ) : (
                <EmptySection>No missions have been started yet.</EmptySection>
              )}
            </Section>

            <Section
              title="Drafts"
              description="Nothing runs until you explicitly start a draft."
            >
              {state?.drafts.length ? (
                <div className="grid gap-3 md:grid-cols-2">
                  {state.drafts.map((draft) => {
                    const key = `${draft.id}:start-draft`;
                    return (
                      <Card key={draft.id}>
                        <CardHeader>
                          <CardTitle className="text-[length:var(--fd-text-base)]">
                            {draft.title}
                          </CardTitle>
                          <p className="text-[length:var(--fd-text-sm)] leading-relaxed text-fg-secondary">
                            {draft.objective}
                          </p>
                        </CardHeader>
                        <CardContent className="flex flex-wrap items-center justify-between gap-3">
                          <span className="text-[length:var(--fd-text-xs)] text-fg-tertiary">
                            {formatDuration(draft.leaseMinutes)} ·{" "}
                            {draft.maxAutomaticTurns} turns · {draft.maxWorkers}{" "}
                            workers · {draft.acceptanceCriteria.length} criteria ·{" "}
                            {AUTONOMOUS_ACCESS_LABEL}
                          </span>
                          <Button
                            size="sm"
                            disabled={pending !== null}
                            onClick={() =>
                              void act(
                                "start-draft",
                                { draftId: draft.id },
                                key,
                              )
                            }
                          >
                            {pending === key ? "Starting…" : "Start mission"}
                          </Button>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              ) : (
                <EmptySection>
                  Start a new Mission, or ask an available task to “start a
                  mission,” to create a draft for review.
                </EmptySection>
              )}
            </Section>

            <Section
              title="Use an existing task"
              description="Choose an idle Claude or Codex task as the Mission coordinator."
            >
              {state?.candidates.length ? (
                <div className="divide-y divide-border-default rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-1">
                  {state.candidates.map((candidate) => {
                    const key = `${candidate.id}:adopt-task`;
                    return (
                      <div
                        key={`${candidate.workspaceId}:${candidate.id}`}
                        className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                            {candidate.title}
                          </p>
                          <p className="mt-0.5 text-[length:var(--fd-text-xs)] text-fg-tertiary">
                            <span className="capitalize">
                              {candidate.provider}
                            </span>{" "}
                            task
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              openThread(candidate.workspaceId, candidate.id)
                            }
                          >
                            Open task
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pending !== null}
                            onClick={() =>
                              void act(
                                "adopt-task",
                                {
                                  workspaceId: candidate.workspaceId,
                                  threadId: candidate.id,
                                  title: candidate.title,
                                },
                                key,
                              )
                            }
                          >
                            {pending === key
                              ? "Starting…"
                              : "Use as coordinator"}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <EmptySection>
                  No eligible idle Claude or Codex tasks right now.
                </EmptySection>
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function resultDraftId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const result =
    root.result && typeof root.result === "object" && !Array.isArray(root.result)
      ? (root.result as Record<string, unknown>)
      : null;
  return typeof result?.draftId === "string" ? result.draftId : null;
}

function MissionDraftToolResult({
  result,
  views,
  invokeAction,
}: ExtensionAppAgentToolResultProps) {
  const draftId = resultDraftId(result);
  const published = useMemo(() => stateFromViews(views), [views]);
  const draft = useMemo(
    () => published?.drafts.find((candidate) => candidate.id === draftId),
    [draftId, published],
  );
  const draftSignature = draft ? JSON.stringify(draft) : null;
  const [editing, setEditing] = useState(false);
  const [started, setStarted] = useState(false);
  const [pending, setPending] = useState<"save" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(draft?.title ?? "");
  const [objective, setObjective] = useState(draft?.objective ?? "");
  const [criteria, setCriteria] = useState(
    draft?.acceptanceCriteria.join("\n") ?? "",
  );
  const [leaseMinutes, setLeaseMinutes] = useState(
    draft?.leaseMinutes ?? 180,
  );
  const [maxAutomaticTurns, setMaxAutomaticTurns] = useState(
    draft?.maxAutomaticTurns ?? 12,
  );
  const [maxWorkers, setMaxWorkers] = useState(draft?.maxWorkers ?? 3);

  useEffect(() => {
    if (!draft) return;
    setTitle(draft.title);
    setObjective(draft.objective);
    setCriteria(draft.acceptanceCriteria.join("\n"));
    setLeaseMinutes(draft.leaseMinutes);
    setMaxAutomaticTurns(draft.maxAutomaticTurns);
    setMaxWorkers(draft.maxWorkers);
  }, [draftSignature]);

  const input = useMemo(
    () => ({
      draftId,
      title,
      objective,
      acceptanceCriteria: criteria
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean),
      leaseMinutes,
      maxAutomaticTurns,
      maxWorkers,
    }),
    [
      criteria,
      draftId,
      leaseMinutes,
      maxAutomaticTurns,
      maxWorkers,
      objective,
      title,
    ],
  );

  const save = useCallback(async () => {
    if (!draftId) return false;
    setPending("save");
    setError(null);
    try {
      await invokeAction("update-draft", input);
      setEditing(false);
      return true;
    } catch (reason) {
      setError(friendlyError(reason));
      return false;
    } finally {
      setPending(null);
    }
  }, [draftId, input, invokeAction]);

  const start = useCallback(async () => {
    if (!draftId) return;
    setPending("start");
    setError(null);
    try {
      await invokeAction("update-draft", input);
      await invokeAction("start-draft", { draftId });
      setEditing(false);
      setStarted(true);
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setPending(null);
    }
  }, [draftId, input, invokeAction]);

  if (!draftId) return null;
  if (started || (!draft && published)) {
    return (
      <Card className="border-success bg-success-muted">
        <CardContent className="flex items-center gap-2 py-4 text-[length:var(--fd-text-sm)] text-success">
          <span aria-hidden="true">✓</span>
          Mission started. This task is now the coordinator.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border-emphasis bg-surface-2 shadow-[var(--fd-shadow-md)]">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-[length:var(--fd-text-xs)] font-medium uppercase tracking-wide text-accent">
              Mission draft ready
            </p>
            <CardTitle className="mt-1 text-[length:var(--fd-text-base)]">
              {title || draft?.title || "Untitled mission"}
            </CardTitle>
          </div>
          <Badge variant="warning">Needs your approval</Badge>
        </div>
        {!editing ? (
          <>
            <p className="text-[length:var(--fd-text-sm)] leading-relaxed text-fg-secondary">
              {objective || draft?.objective}
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--fd-text-xs)] text-fg-tertiary">
              <span>{formatDuration(leaseMinutes)}</span>
              <span>{maxAutomaticTurns} coordinator turns</span>
              <span>{maxWorkers} workers</span>
              <span>{input.acceptanceCriteria.length} acceptance criteria</span>
            </div>
          </>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-[var(--fd-radius-md)] border border-info/25 bg-info-muted px-3.5 py-3 text-[length:var(--fd-text-xs)] leading-relaxed text-info">
          <span className="font-medium">Autonomous access:</span>{" "}
          {AUTONOMOUS_ACCESS_LABEL}. Starting authorizes this coordinator and
          its Mission workers to run without routine tool approvals.
        </div>
        {editing ? (
          <div className="space-y-3">
            <label className="block space-y-1.5 text-[length:var(--fd-text-xs)] font-medium text-fg-secondary">
              <span>Title</span>
              <input
                value={title}
                maxLength={120}
                onChange={(event) => setTitle(event.target.value)}
                className="fd-focus h-9 w-full rounded-[var(--fd-radius-md)] border border-border-default bg-surface-1 px-3 text-[length:var(--fd-text-sm)] text-fg-primary"
              />
            </label>
            <label className="block space-y-1.5 text-[length:var(--fd-text-xs)] font-medium text-fg-secondary">
              <span>Objective</span>
              <textarea
                value={objective}
                rows={4}
                maxLength={12_000}
                onChange={(event) => setObjective(event.target.value)}
                className="fd-focus w-full resize-y rounded-[var(--fd-radius-md)] border border-border-default bg-surface-1 px-3 py-2 text-[length:var(--fd-text-sm)] leading-relaxed text-fg-primary"
              />
            </label>
            <label className="block space-y-1.5 text-[length:var(--fd-text-xs)] font-medium text-fg-secondary">
              <span>Acceptance criteria · one per line</span>
              <textarea
                value={criteria}
                rows={4}
                onChange={(event) => setCriteria(event.target.value)}
                className="fd-focus w-full resize-y rounded-[var(--fd-radius-md)] border border-border-default bg-surface-1 px-3 py-2 text-[length:var(--fd-text-sm)] leading-relaxed text-fg-primary"
              />
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <NumberField
                label="Time limit (minutes)"
                value={leaseMinutes}
                minimum={15}
                maximum={1_440}
                onChange={setLeaseMinutes}
              />
              <NumberField
                label="Coordinator turns"
                value={maxAutomaticTurns}
                minimum={1}
                maximum={24}
                onChange={setMaxAutomaticTurns}
              />
              <NumberField
                label="Workers"
                value={maxWorkers}
                minimum={0}
                maximum={4}
                onChange={setMaxWorkers}
              />
            </div>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-[length:var(--fd-text-xs)] text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border-default pt-4">
          {editing ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending !== null}
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending !== null}
                onClick={() => void save()}
              >
                {pending === "save" ? "Saving…" : "Save draft"}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={!draft || pending !== null}
              onClick={() => setEditing(true)}
            >
              Review and edit
            </Button>
          )}
          <Button
            size="sm"
            disabled={!draft || pending !== null}
            onClick={() => void start()}
          >
            {pending === "start" ? "Starting…" : "Start mission"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function NumberField({
  label,
  value,
  minimum,
  maximum,
  onChange,
}: {
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  onChange(value: number): void;
}) {
  return (
    <label className="block space-y-1.5 text-[length:var(--fd-text-xs)] font-medium text-fg-secondary">
      <span>{label}</span>
      <input
        type="number"
        min={minimum}
        max={maximum}
        step={1}
        value={value}
        onChange={(event) => {
          if (!Number.isNaN(event.target.valueAsNumber)) {
            onChange(event.target.valueAsNumber);
          }
        }}
        className="fd-focus h-9 w-full rounded-[var(--fd-radius-md)] border border-border-default bg-surface-1 px-3 text-[length:var(--fd-text-sm)] tabular-nums text-fg-primary"
      />
    </label>
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
    toolId: "draft-mission",
    component: MissionDraftToolResult,
  });
});
