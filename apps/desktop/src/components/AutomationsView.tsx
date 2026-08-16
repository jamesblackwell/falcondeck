import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  AgentControlSettings,
  Automation,
  AutomationRun,
  ControlErrorDetail,
} from "@falcondeck/client-core";
import {
  ActivityDiamond,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Textarea,
} from "@falcondeck/ui";
import { CalendarClock, Pause, Play, Plus, Trash2, X } from "lucide-react";

import { useControlStateEvents } from "../hooks/useControlStateEvents";
import {
  ControlRequestError,
  executeControl,
  listAutomations,
  listRuns,
  readAutomation,
  readSettings,
} from "../control-api";

export type AutomationsViewProps = {
  baseUrl: string | null;
  onToast: (toast: {
    variant: "success" | "danger" | "warning" | "default";
    title: string;
    description?: string;
  }) => void;
  /** Optional event subscription; the app wires control-state events so
   * conversational changes appear without a restart or polling. */
  onEventRefetch?: (() => void) | null;
};

type EditorState =
  | { kind: "closed" }
  | { kind: "create"; draft: AutomationDraft }
  | { kind: "edit"; id: string; revision: number; draft: AutomationDraft };

type AutomationDraft = {
  name: string;
  description: string;
  scheduleKind: "cron" | "interval" | "once";
  expression: string;
  timezone: string;
  everySeconds: string;
  runAt: string;
  instruction: string;
  conditional: boolean;
  noActionMarker: string;
  workspacePath: string;
  provider: string;
  threadKind: "managed" | "existing" | "new_each_run";
  /** Preserved managed/existing thread id so edits never reset the thread. */
  threadId: string;
  modelId: string;
  permissionMode: string;
  sandboxMode: string;
  requiredConnectors: string;
  selectedSkills: string;
  concurrencyPolicy: "skip" | "queue_one" | "allow";
  misfirePolicy: "skip" | "run_once";
  /** Preserved interval anchor so edits never shift the schedule grid. */
  anchorAt: string;
};

const STATE_BADGE: Record<Automation["state"], "success" | "warning" | "default" | "danger"> = {
  enabled: "success",
  paused: "warning",
  completed: "default",
  failed: "danger",
};

const RUN_BADGE: Record<AutomationRun["status"], "success" | "warning" | "default" | "danger"> = {
  queued: "default",
  running: "warning",
  succeeded: "success",
  succeeded_no_action: "success",
  failed: "danger",
  skipped_overlap: "default",
  skipped_dependency: "warning",
  cancelled: "default",
};

function emptyDraft(settings: AgentControlSettings | null, workspacePath = ""): AutomationDraft {
  return {
    name: "",
    description: "",
    scheduleKind: "cron",
    expression: "0 8 * * 1-5",
    timezone: settings?.default_timezone ?? "Europe/London",
    everySeconds: "3600",
    runAt: "",
    instruction: "",
    conditional: false,
    noActionMarker: "FALCONDECK_NO_ACTION",
    workspacePath,
    provider: "codex",
    threadKind: "managed",
    threadId: "",
    modelId: "",
    permissionMode: "",
    sandboxMode: "",
    requiredConnectors: "",
    selectedSkills: "",
    concurrencyPolicy: "skip",
    misfirePolicy: "skip",
    anchorAt: "",
  };
}

function draftFromAutomation(automation: Automation): AutomationDraft {
  const thread = automation.target.thread;
  return {
    name: automation.name,
    description: automation.description ?? "",
    scheduleKind: automation.trigger.kind,
    expression: automation.trigger.kind === "cron" ? automation.trigger.expression : "",
    timezone: automation.trigger.kind === "cron" ? automation.trigger.timezone : "",
    everySeconds:
      automation.trigger.kind === "interval"
        ? String(automation.trigger.every_seconds)
        : "3600",
    runAt: automation.trigger.kind === "once" ? automation.trigger.run_at : "",
    instruction: automation.task.instruction,
    conditional: automation.task.kind === "conditional_prompt",
    noActionMarker:
      automation.task.kind === "conditional_prompt" ? automation.task.no_action_marker : "",
    workspacePath: automation.target.workspace_path,
    provider: automation.target.provider,
    threadKind: thread.kind,
    threadId: thread.kind === "managed" || thread.kind === "existing" ? thread.thread_id ?? "" : "",
    modelId: automation.target.model_id ?? "",
    permissionMode: automation.target.permission_mode ?? "",
    sandboxMode: automation.target.sandbox_mode ?? "",
    requiredConnectors: automation.required_connectors.join(", "),
    selectedSkills: (automation.target.selected_skills ?? []).join(", "),
    concurrencyPolicy: automation.concurrency_policy,
    misfirePolicy: automation.misfire_policy,
    anchorAt:
      automation.trigger.kind === "interval" ? automation.trigger.anchor_at : "",
  };
}

function draftArguments(draft: AutomationDraft): Record<string, unknown> {
  const trigger =
    draft.scheduleKind === "cron"
      ? { kind: "cron", expression: draft.expression.trim(), timezone: draft.timezone.trim() }
      : draft.scheduleKind === "interval"
        ? {
            kind: "interval",
            every_seconds: Number(draft.everySeconds) || 0,
            // Editing must never shift the schedule grid: keep the stored
            // anchor and only fall back to now for brand-new automations.
            anchor_at: draft.anchorAt.trim() || new Date().toISOString(),
          }
        : { kind: "once", run_at: draft.runAt.trim() };
  const task = draft.conditional
    ? {
        kind: "conditional_prompt",
        instruction: draft.instruction,
        no_action_marker: draft.noActionMarker.trim(),
      }
    : { kind: "prompt", instruction: draft.instruction };
  return {
    name: draft.name.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    trigger,
    task,
    target: {
      workspace_path: draft.workspacePath.trim(),
      provider: draft.provider,
      thread:
        draft.threadKind === "managed"
          ? {
              kind: "managed",
              ...(draft.threadId.trim() ? { thread_id: draft.threadId.trim() } : {}),
            }
          : draft.threadKind === "existing"
            ? { kind: "existing", thread_id: draft.threadId.trim() }
            : { kind: "new_each_run" },
      ...(draft.modelId.trim() ? { model_id: draft.modelId.trim() } : {}),
      ...(draft.permissionMode.trim()
        ? { permission_mode: draft.permissionMode.trim() }
        : {}),
      ...(draft.sandboxMode.trim() ? { sandbox_mode: draft.sandboxMode.trim() } : {}),
      selected_skills: draft.selectedSkills
        .split(",")
        .map((skill) => skill.trim())
        .filter(Boolean),
    },
    required_connectors: draft.requiredConnectors
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
    concurrency_policy: draft.concurrencyPolicy,
    misfire_policy: draft.misfirePolicy,
  };
}

function draftIsSubmittable(draft: AutomationDraft): string | null {
  if (!draft.name.trim()) return "A name is required.";
  if (!draft.instruction.trim()) return "An instruction is required.";
  if (!draft.workspacePath.trim().startsWith("/")) return "Workspace path must be absolute.";
  if (draft.scheduleKind === "cron" && draft.expression.trim().split(/\s+/).length !== 5) {
    return "Cron expressions use exactly five fields.";
  }
  if (draft.scheduleKind === "interval" && Number(draft.everySeconds) < 60) {
    return "Intervals must be at least 60 seconds.";
  }
  if (draft.scheduleKind === "once" && !draft.runAt.trim()) {
    return "A one-time schedule needs an RFC 3339 timestamp with an offset.";
  }
  if (draft.conditional && !draft.noActionMarker.trim()) {
    return "Conditional automations need a no-action marker.";
  }
  return null;
}

function draftIsElevated(draft: AutomationDraft): boolean {
  return [draft.permissionMode.trim(), draft.sandboxMode.trim()].some((mode) =>
    ["bypassPermissions", "danger-full-access"].includes(mode),
  );
}

export function AutomationsView({ baseUrl, onToast, onEventRefetch }: AutomationsViewProps) {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [settings, setSettings] = useState<AgentControlSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [editor, setEditor] = useState<EditorState>({ kind: "closed" });
  const [historyFor, setHistoryFor] = useState<Automation | null>(null);
  const [historyRuns, setHistoryRuns] = useState<AutomationRun[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!baseUrl) return;
    setLoadError(null);
    try {
      const [nextAutomations, nextSettings] = await Promise.all([
        listAutomations(baseUrl),
        readSettings(baseUrl).catch(() => null),
      ]);
      setAutomations(nextAutomations);
      setSettings(nextSettings);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  // Conversational (MCP-originated) changes surface immediately through the
  // daemon's control-state events while this panel is open.
  useControlStateEvents(baseUrl, () => {
    void load();
    onEventRefetch?.();
  });

  const openHistory = useCallback(
    async (automation: Automation) => {
      setHistoryFor(automation);
      setHistoryRuns(null);
      if (!baseUrl) return;
      try {
        setHistoryRuns(await listRuns(baseUrl, automation.id));
      } catch {
        setHistoryRuns([]);
      }
    },
    [baseUrl],
  );

  const runOperation = useCallback(
    async (
      operation: string,
      arguments_: Record<string, unknown>,
      options?: { expectedRevision?: number; id?: string },
    ) => {
      if (!baseUrl) return;
      if (options?.id) setBusyId(options.id);
      try {
        await executeControl(baseUrl, {
          operation,
          arguments: arguments_,
          expected_revision: options?.expectedRevision,
        });
        await load();
        onToast({ variant: "success", title: "Automation updated" });
      } catch (error) {
        const detail: ControlErrorDetail | null =
          error instanceof ControlRequestError ? error.detail : null;
        onToast({
          variant: "danger",
          title:
            detail?.code === "revision_conflict"
              ? "This automation changed elsewhere"
              : "Operation failed",
          description:
            detail?.suggested_action ??
            (error instanceof Error ? error.message : String(error)),
        });
        // A conflict always means our copy is stale; refetch the truth.
        if (detail?.code === "revision_conflict") {
          await load();
        }
      } finally {
        setBusyId(null);
      }
    },
    [baseUrl, load, onToast],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[length:var(--fd-text-2xl)] font-semibold text-fg-primary">
            Automations
          </h1>
          <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-muted">
            Scheduled agent instructions stored by this daemon. Automations run through the same
            threads and turns as everything else, and they keep running when conversational
            control is disabled.
          </p>
        </div>
        <Button
          onClick={() =>
            setEditor({ kind: "create", draft: emptyDraft(settings) })
          }
        >
          <Plus className="h-4 w-4" />
          New automation
        </Button>
      </div>

      {loadError ? (
        <div className="flex items-center gap-3 rounded-[var(--fd-radius-lg)] border border-border-subtle px-4 py-3">
          <p className="min-w-0 flex-1 truncate text-[length:var(--fd-text-sm)] text-danger">
            {loadError}
          </p>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center gap-2 px-2 py-10 text-[length:var(--fd-text-sm)] text-fg-muted">
          <ActivityDiamond size="md" />
          Loading automations…
        </div>
      ) : automations.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-[var(--fd-radius-lg)] border border-dashed border-border-subtle px-6 py-12 text-center">
          <CalendarClock className="h-6 w-6 text-fg-muted" />
          <p className="text-[length:var(--fd-text-sm)] text-fg-secondary">
            No automations yet. Ask an agent to schedule one, or create it here.
          </p>
        </div>
      ) : (
        <Card>
          <CardContent className="space-y-2 pt-6">
            {automations.map((automation) => (
              <div
                key={automation.id}
                className="rounded-[var(--fd-radius-lg)] border border-border-subtle px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 truncate text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                    {automation.name}
                  </span>
                  <Badge variant={STATE_BADGE[automation.state]}>{automation.state}</Badge>
                  <Badge variant="default">{automation.target.provider}</Badge>
                  {automation.elevated ? (
                    <Badge variant="danger">elevated</Badge>
                  ) : null}
                  <span className="ml-auto flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busyId === automation.id}
                      onClick={() =>
                        void runOperation(
                          automation.state === "enabled"
                            ? "automation.pause"
                            : "automation.resume",
                          { automation_id: automation.id },
                          { expectedRevision: automation.revision, id: automation.id },
                        )
                      }
                    >
                      {automation.state === "enabled" ? (
                        <>
                          <Pause className="h-3.5 w-3.5" /> Pause
                        </>
                      ) : (
                        <>
                          <Play className="h-3.5 w-3.5" /> Resume
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busyId === automation.id}
                      onClick={() =>
                        void runOperation(
                          "automation.run_now",
                          { automation_id: automation.id },
                          { id: automation.id },
                        )
                      }
                    >
                      Run now
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void openHistory(automation)}
                    >
                      History
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busyId === automation.id}
                      onClick={async () => {
                        if (!baseUrl) return;
                        let detail: Automation | null;
                        try {
                          detail = await readAutomation(baseUrl, automation.id);
                        } catch (error) {
                          onToast({
                            variant: "danger",
                            title: "Could not open the automation",
                            description:
                              error instanceof ControlRequestError
                                ? error.detail?.suggested_action ?? error.message
                                : error instanceof Error
                                  ? error.message
                                  : String(error),
                          });
                          await load();
                          return;
                        }
                        if (!detail) return;
                        setEditor({
                          kind: "edit",
                          id: automation.id,
                          revision: automation.revision,
                          draft: draftFromAutomation(detail),
                        });
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete ${automation.name}`}
                      disabled={busyId === automation.id}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Delete the automation "${automation.name}"? Run history is kept.`,
                          )
                        )
                          return;
                        void runOperation(
                          "automation.delete",
                          { automation_id: automation.id },
                          { expectedRevision: automation.revision, id: automation.id },
                        );
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </span>
                </div>
                <p className="mt-1 truncate font-mono text-[length:var(--fd-text-xs)] text-fg-muted">
                  {automation.resolved_schedule ??
                    (automation.trigger.kind === "cron"
                      ? `cron "${automation.trigger.expression}" (${automation.trigger.timezone})`
                      : automation.trigger.kind === "interval"
                        ? `every ${Math.round(automation.trigger.every_seconds / 60)} minutes`
                        : `once at ${automation.trigger.run_at}`)}
                  {" · "}
                  {automation.target.workspace_path}
                </p>
                <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
                  {automation.next_run_at
                    ? `Next run ${new Date(automation.next_run_at).toLocaleString()}`
                    : "No scheduled run"}
                  {automation.latest_outcome
                    ? ` · Last: ${automation.latest_outcome.status} (${new Date(
                        automation.latest_outcome.finished_at,
                      ).toLocaleString()})`
                    : " · Never run"}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {historyFor ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle>Run history — {historyFor.name}</CardTitle>
              <CardDescription>
                Bounded previews; the full replies stay in the native threads.
              </CardDescription>
            </div>
            <Button size="icon" variant="ghost" aria-label="Close history" onClick={() => setHistoryFor(null)}>
              <X className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {historyRuns === null ? (
              <div className="flex items-center justify-center gap-2 px-2 py-6 text-[length:var(--fd-text-sm)] text-fg-muted">
                <ActivityDiamond size="md" /> Loading runs…
              </div>
            ) : historyRuns.length === 0 ? (
              <p className="px-2 py-6 text-center text-[length:var(--fd-text-sm)] text-fg-muted">
                This automation has not run yet.
              </p>
            ) : (
              historyRuns.map((run) => (
                <div
                  key={run.id}
                  className="flex items-center gap-3 rounded-[var(--fd-radius-lg)] border border-border-subtle px-4 py-2.5"
                >
                  <Badge variant={RUN_BADGE[run.status]}>{run.status}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[length:var(--fd-text-sm)] text-fg-primary">
                      {run.outcome_preview ?? run.error?.message ?? "—"}
                    </p>
                    <p className="truncate font-mono text-[length:var(--fd-text-xs)] text-fg-muted">
                      {new Date(run.queued_at).toLocaleString()}
                      {run.thread_id ? ` · thread ${run.thread_id.slice(0, 12)}` : ""}
                    </p>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      ) : null}

      {editor.kind !== "closed" ? (
        <AutomationEditor
          key={editor.kind === "edit" ? editor.id : "create"}
          state={editor}
          allowElevated={settings?.allow_elevated_automations ?? false}
          onCancel={() => setEditor({ kind: "closed" })}
          onSubmit={async (draft) => {
            if (editor.kind === "create") {
              await runOperation("automation.create", draftArguments(draft));
            } else {
              await runOperation("automation.update", {
                automation_id: editor.id,
                ...draftArguments(draft),
              }, { expectedRevision: editor.revision });
            }
            setEditor({ kind: "closed" });
          }}
        />
      ) : null}
    </div>
  );
}

function AutomationEditor({
  state,
  allowElevated,
  onCancel,
  onSubmit,
}: {
  state: Extract<EditorState, { kind: "create" | "edit" }>;
  allowElevated: boolean;
  onCancel: () => void;
  onSubmit: (draft: AutomationDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<AutomationDraft>(state.draft);
  const [validation, setValidation] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const elevated = useMemo(() => draftIsElevated(draft), [draft]);
  const error = useMemo(() => draftIsSubmittable(draft), [draft]);
  const disabled = Boolean(error) || isBusy || (elevated && !allowElevated);

  const set = <K extends keyof AutomationDraft>(field: K, value: AutomationDraft[K]) =>
    setDraft((current) => ({ ...current, [field]: value }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{state.kind === "create" ? "New automation" : "Edit automation"}</CardTitle>
        <CardDescription>
          {state.kind === "edit"
            ? "Saves with the revision you loaded; a stale edit is rejected and refreshed."
            : "The same validated payload agents send through falcondeck_execute."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-[length:var(--fd-text-xs)] text-fg-muted">Name</span>
            <Input
              aria-label="Automation name"
              value={draft.name}
              onChange={(event) => set("name", event.target.value)}
              placeholder="Weekday inbox review"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[length:var(--fd-text-xs)] text-fg-muted">Description</span>
            <Input
              aria-label="Automation description"
              value={draft.description}
              onChange={(event) => set("description", event.target.value)}
              placeholder="Optional"
            />
          </label>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <label className="space-y-1">
            <span className="text-[length:var(--fd-text-xs)] text-fg-muted">Schedule type</span>
            <select
              aria-label="Schedule type"
              value={draft.scheduleKind}
              onChange={(event) =>
                set("scheduleKind", event.target.value as AutomationDraft["scheduleKind"])
              }
              className="h-9 w-full rounded-[var(--fd-radius-md)] border border-border bg-surface-1 px-3 text-[length:var(--fd-text-sm)] text-fg-primary"
            >
              <option value="cron">Cron</option>
              <option value="interval">Interval</option>
              <option value="once">One time</option>
            </select>
          </label>
          {draft.scheduleKind === "cron" ? (
            <>
              <label className="space-y-1">
                <span className="text-[length:var(--fd-text-xs)] text-fg-muted">
                  Expression (five fields)
                </span>
                <Input
                  aria-label="Cron expression"
                  value={draft.expression}
                  onChange={(event) => set("expression", event.target.value)}
                  placeholder="0 8 * * 1-5"
                  className="font-mono"
                />
              </label>
              <label className="space-y-1">
                <span className="text-[length:var(--fd-text-xs)] text-fg-muted">Timezone</span>
                <Input
                  aria-label="Cron timezone"
                  value={draft.timezone}
                  onChange={(event) => set("timezone", event.target.value)}
                  placeholder="Europe/London"
                  className="font-mono"
                />
              </label>
            </>
          ) : draft.scheduleKind === "interval" ? (
            <label className="space-y-1">
              <span className="text-[length:var(--fd-text-xs)] text-fg-muted">
                Every (seconds, min 60)
              </span>
              <Input
                aria-label="Interval seconds"
                value={draft.everySeconds}
                onChange={(event) => set("everySeconds", event.target.value)}
                inputMode="numeric"
                className="font-mono"
              />
            </label>
          ) : (
            <label className="space-y-1">
              <span className="text-[length:var(--fd-text-xs)] text-fg-muted">
                Run at (RFC 3339 with offset)
              </span>
              <Input
                aria-label="One-time run-at"
                value={draft.runAt}
                onChange={(event) => set("runAt", event.target.value)}
                placeholder="2026-08-17T10:00:00+01:00"
                className="font-mono"
              />
            </label>
          )}
        </div>

        <label className="block space-y-1">
          <span className="text-[length:var(--fd-text-xs)] text-fg-muted">Instruction</span>
          <Textarea
            aria-label="Automation instruction"
            value={draft.instruction}
            onChange={(event) => set("instruction", event.target.value)}
            placeholder="Review my inbox. Surface messages that need my attention."
            className="min-h-24"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex items-center gap-2 rounded-[var(--fd-radius-lg)] border border-border-subtle px-4 py-3">
            <input
              type="checkbox"
              aria-label="Conditional automation"
              checked={draft.conditional}
              onChange={(event) => set("conditional", event.target.checked)}
            />
            <span className="text-[length:var(--fd-text-sm)] text-fg-primary">
              Conditional (no-action marker)
            </span>
          </label>
          {draft.conditional ? (
            <label className="space-y-1">
              <span className="text-[length:var(--fd-text-xs)] text-fg-muted">
                No-action marker
              </span>
              <Input
                aria-label="No-action marker"
                value={draft.noActionMarker}
                onChange={(event) => set("noActionMarker", event.target.value)}
                placeholder="FALCONDECK_NO_ACTION"
                className="font-mono"
              />
            </label>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-[length:var(--fd-text-xs)] text-fg-muted">
              Workspace path
            </span>
            <Input
              aria-label="Workspace path"
              value={draft.workspacePath}
              onChange={(event) => set("workspacePath", event.target.value)}
              placeholder="/Users/james/Code/quizgecko"
              className="font-mono"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[length:var(--fd-text-xs)] text-fg-muted">Provider</span>
            <select
              aria-label="Provider"
              value={draft.provider}
              onChange={(event) => set("provider", event.target.value)}
              className="h-9 w-full rounded-[var(--fd-radius-md)] border border-border bg-surface-1 px-3 text-[length:var(--fd-text-sm)] text-fg-primary"
            >
              <option value="codex">codex</option>
              <option value="claude">claude</option>
            </select>
          </label>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <label className="space-y-1">
            <span className="text-[length:var(--fd-text-xs)] text-fg-muted">Thread strategy</span>
            <select
              aria-label="Thread strategy"
              value={draft.threadKind}
              onChange={(event) =>
                set("threadKind", event.target.value as AutomationDraft["threadKind"])
              }
              className="h-9 w-full rounded-[var(--fd-radius-md)] border border-border bg-surface-1 px-3 text-[length:var(--fd-text-sm)] text-fg-primary"
            >
              <option value="managed">Managed thread</option>
              <option value="existing">Existing thread</option>
              <option value="new_each_run">New thread each run</option>
            </select>
          </label>
          {draft.threadKind !== "new_each_run" ? (
            <label className="space-y-1">
              <span className="text-[length:var(--fd-text-xs)] text-fg-muted">
                Thread id (kept between edits)
              </span>
              <Input
                aria-label="Thread id"
                value={draft.threadId}
                onChange={(event) => set("threadId", event.target.value)}
                placeholder="Assigned on first run"
                className="font-mono"
              />
            </label>
          ) : null}
          <label className="space-y-1">
            <span className="text-[length:var(--fd-text-xs)] text-fg-muted">Permission mode</span>
            <Input
              aria-label="Permission mode"
              value={draft.permissionMode}
              onChange={(event) => set("permissionMode", event.target.value)}
              placeholder="default"
              className="font-mono"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[length:var(--fd-text-xs)] text-fg-muted">Sandbox mode</span>
            <Input
              aria-label="Sandbox mode"
              value={draft.sandboxMode}
              onChange={(event) => set("sandboxMode", event.target.value)}
              placeholder="workspace-write"
              className="font-mono"
            />
          </label>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <label className="space-y-1">
            <span className="text-[length:var(--fd-text-xs)] text-fg-muted">
              Required connectors
            </span>
            <Input
              aria-label="Required connectors"
              value={draft.requiredConnectors}
              onChange={(event) => set("requiredConnectors", event.target.value)}
              placeholder="gmail, linear"
              className="font-mono"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[length:var(--fd-text-xs)] text-fg-muted">
              Concurrency policy
            </span>
            <select
              aria-label="Concurrency policy"
              value={draft.concurrencyPolicy}
              onChange={(event) =>
                set(
                  "concurrencyPolicy",
                  event.target.value as AutomationDraft["concurrencyPolicy"],
                )
              }
              className="h-9 w-full rounded-[var(--fd-radius-md)] border border-border bg-surface-1 px-3 text-[length:var(--fd-text-sm)] text-fg-primary"
            >
              <option value="skip">Skip overlaps</option>
              <option value="queue_one">Queue one</option>
              <option value="allow">Allow overlap</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[length:var(--fd-text-xs)] text-fg-muted">Misfire policy</span>
            <select
              aria-label="Misfire policy"
              value={draft.misfirePolicy}
              onChange={(event) =>
                set("misfirePolicy", event.target.value as AutomationDraft["misfirePolicy"])
              }
              className="h-9 w-full rounded-[var(--fd-radius-md)] border border-border bg-surface-1 px-3 text-[length:var(--fd-text-sm)] text-fg-primary"
            >
              <option value="skip">Skip missed</option>
              <option value="run_once">Run once after restart</option>
            </select>
          </label>
        </div>

        {elevated ? (
          <div className="rounded-[var(--fd-radius-lg)] border border-danger/40 bg-surface-2 px-4 py-3 text-[length:var(--fd-text-sm)] text-fg-primary">
            <strong>Elevated authority.</strong> This automation uses bypassPermissions or
            danger-full-access.
            {!allowElevated
              ? " Elevated automations are disabled in agent control settings, so this cannot be saved."
              : ""}
          </div>
        ) : null}

        {validation ? (
          <p className="text-[length:var(--fd-text-sm)] text-danger">{validation}</p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={disabled}
            onClick={async () => {
              const currentError = draftIsSubmittable(draft);
              if (currentError) {
                setValidation(currentError);
                return;
              }
              setValidation(null);
              setIsBusy(true);
              try {
                await onSubmit(draft);
              } finally {
                setIsBusy(false);
              }
            }}
          >
            {isBusy ? <ActivityDiamond size="md" tone="current" /> : null}
            {state.kind === "create" ? "Create automation" : "Save changes"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
