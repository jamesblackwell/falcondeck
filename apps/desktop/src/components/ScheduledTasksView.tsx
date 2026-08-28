import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CalendarClock,
  ChevronDown,
  CircleAlert,
  Clock3,
  MessageCircle,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";

import type {
  AgentProvider,
  AgentControlSettings,
  Automation,
  AutomationRun,
  CreateScheduledTaskPayload,
  DaemonSnapshot,
  ScheduledTaskDetail,
  ScheduledTaskRunSummary,
  ScheduledTaskSummary,
  UpdateScheduledTaskPayload,
  WorkspaceSummary,
} from "@falcondeck/client-core";
import { approvalPolicyForProvider } from "@falcondeck/client-core";
import { Button, Popover, cn } from "@falcondeck/ui";

import type { HostManager, HostScopedApi, HostView } from "../hosts";
import { useControlStateEvents } from "../hooks/useControlStateEvents";
import { utcToWallTime, wallTimeToUtc } from "../scheduled-time";
import {
  AutomationEditor,
} from "./AutomationsView";
import {
  automationDraftArguments,
  automationDraftFrom,
} from "./automation-draft";

type Toast = (toast: {
  variant: "default" | "success" | "danger";
  title: string;
  description?: string;
}) => void;

type TaskEntry = {
  hostId: string | null;
  hostName: string;
  online: boolean;
  supported: boolean;
  workspaces: WorkspaceSummary[];
  task: ScheduledTaskSummary;
  automation: Automation | null;
};

type LegacyEditorState =
  | { kind: "create" }
  | { kind: "edit"; entry: TaskEntry; detail: ScheduledTaskDetail }
  | null;

type AutomationEditorSelection = {
  entry: TaskEntry;
  automation: Automation;
};

function taskEntryKey(entry: TaskEntry) {
  return `${entry.hostId ?? "local"}:${entry.task.id}`;
}

function controlErrorMessage(
  response: Awaited<ReturnType<HostScopedApi["controlExecute"]>>,
) {
  return (
    response.error?.suggested_action ??
    response.error?.message ??
    "FalconDeck could not complete the automation action."
  );
}

function handleMenuKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
  onClose?: () => void,
) {
  if (event.key === "Escape") {
    if (onClose) {
      event.preventDefault();
      onClose();
    }
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      "[role=menuitem]:not(:disabled)",
    ),
  ];
  if (!items.length) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLElement);
  const offset = event.key === "ArrowDown" ? 1 : -1;
  const base = current < 0 ? (offset > 0 ? -1 : 0) : current;
  items[(base + offset + items.length) % items.length]?.focus();
}

const inputClass =
  "fd-focus w-full rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2 px-3 py-2 text-[length:var(--fd-text-sm)] text-fg-primary placeholder:text-fg-muted";

const RRULE_TO_CRON_DAY: Record<string, string> = {
  MO: "MON",
  TU: "TUE",
  WE: "WED",
  TH: "THU",
  FR: "FRI",
  SA: "SAT",
  SU: "SUN",
};

function hostApi(
  hostId: string | null,
  localApi: HostScopedApi | null,
  manager: HostManager,
) {
  return hostId
    ? (manager.connection(hostId)?.scheduledApi() ?? null)
    : localApi;
}

function humanSchedule(entry: TaskEntry) {
  const automation = entry.automation;
  if (automation) {
    if (automation.resolved_schedule) return automation.resolved_schedule;
    if (automation.trigger.kind === "cron") {
      return `Cron ${automation.trigger.expression} (${automation.trigger.timezone})`;
    }
    if (automation.trigger.kind === "interval") {
      return `Every ${Math.round(automation.trigger.every_seconds / 60)} minutes`;
    }
    return `Once · ${new Date(automation.trigger.run_at).toLocaleString()}`;
  }
  const task = entry.task;
  if (task.schedule.kind === "once") {
    return `Once · ${new Date(task.schedule.run_at).toLocaleString(undefined, { timeZone: task.schedule.timezone })} (${task.schedule.timezone})`;
  }
  const rule = Object.fromEntries(
    task.schedule.rrule
      .replace(/^RRULE:/i, "")
      .split(";")
      .flatMap((part) => {
        const pair = part.split("=");
        return pair.length === 2 ? [[pair[0] ?? "", pair[1] ?? ""]] : [];
      }),
  );
  const time = `${String(Number(rule.BYHOUR ?? 9)).padStart(2, "0")}:${String(Number(rule.BYMINUTE ?? 0)).padStart(2, "0")}`;
  if (rule.FREQ === "WEEKLY")
    return `Weekly · ${rule.BYDAY ?? "MO"} at ${time} (${task.schedule.timezone})`;
  if (rule.FREQ === "HOURLY")
    return `Every ${rule.INTERVAL ?? 1} hour(s) (${task.schedule.timezone})`;
  if (rule.FREQ === "MINUTELY")
    return `Every ${rule.INTERVAL ?? 5} minutes (${task.schedule.timezone})`;
  return `Daily at ${time} (${task.schedule.timezone})`;
}

function nextRunLabel(entry: TaskEntry) {
  if (entry.automation?.state === "failed") return "Failed";
  const task = entry.task;
  if (task.status === "paused") return "Paused";
  if (task.status === "completed") return "Completed";
  if (!task.next_run_at) return "Not scheduled";
  return `Next ${new Date(task.next_run_at).toLocaleString(undefined, { timeZone: task.schedule.timezone })}`;
}

function automationStatus(automation: Automation): ScheduledTaskSummary["status"] {
  if (automation.state === "enabled") return "active";
  if (automation.state === "paused" || automation.state === "failed")
    return "paused";
  return "completed";
}

function automationAsScheduledTask(
  automation: Automation,
  workspaces: WorkspaceSummary[],
): ScheduledTaskSummary {
  const workspace = workspaces.find(
    (candidate) => candidate.path === automation.target.workspace_path,
  );
  const timezone =
    automation.trigger.kind === "cron" ? automation.trigger.timezone : "UTC";
  const schedule: ScheduledTaskSummary["schedule"] =
    automation.trigger.kind === "once"
      ? { kind: "once", run_at: automation.trigger.run_at, timezone }
      : {
          kind: "recurring",
          rrule:
            automation.trigger.kind === "interval"
              ? `FREQ=MINUTELY;INTERVAL=${Math.max(1, Math.round(automation.trigger.every_seconds / 60))}`
              : "FREQ=DAILY;BYHOUR=0;BYMINUTE=0",
          timezone,
        };
  return {
    id: automation.id,
    title: automation.name,
    prompt_preview: automation.description ?? "",
    status: automationStatus(automation),
    schedule,
    workspace_id: workspace?.id ?? "",
    provider: automation.target.provider,
    next_run_at: automation.next_run_at,
    last_run: automation.latest_outcome
      ? {
          id: `latest-${automation.id}`,
          task_id: automation.id,
          status:
            automation.latest_outcome.status === "succeeded_no_action"
              ? "succeeded"
              : automation.latest_outcome.status === "skipped_overlap" ||
                  automation.latest_outcome.status === "skipped_dependency"
                ? "skipped"
                : automation.latest_outcome.status === "cancelled"
                  ? "interrupted"
                  : automation.latest_outcome.status,
          trigger: "scheduled",
          scheduled_for: automation.latest_outcome.finished_at,
          completed_at: automation.latest_outcome.finished_at,
          workspace_id: workspace?.id ?? "",
          preview: automation.latest_outcome.preview,
        }
      : null,
    updated_at: automation.updated_at,
  };
}

function recurringParts(detail: ScheduledTaskDetail | null) {
  if (!detail || detail.schedule.kind !== "recurring")
    return { time: "09:00", weekdays: ["MO"] };
  const parts = Object.fromEntries(
    detail.schedule.rrule.split(";").map((part) => part.split("=", 2)),
  );
  return {
    time: `${String(Number(parts.BYHOUR ?? 9)).padStart(2, "0")}:${String(Number(parts.BYMINUTE ?? 0)).padStart(2, "0")}`,
    weekdays: parts.BYDAY?.split(",") ?? ["MO"],
  };
}

function TaskEditor({
  state,
  localSnapshot,
  hosts,
  localApi,
  manager,
  onClose,
  onSaved,
  onToast,
}: {
  state: Exclude<LegacyEditorState, null>;
  localSnapshot: DaemonSnapshot | null;
  hosts: HostView[];
  localApi: HostScopedApi | null;
  manager: HostManager;
  onClose: () => void;
  onSaved: () => void;
  onToast: Toast;
}) {
  const editing = state.kind === "edit" ? state.detail : null;
  const initialHostId =
    state.kind === "edit"
      ? state.entry.hostId
      : localApi && localSnapshot?.daemon.capabilities?.scheduled_tasks
        ? null
        : (hosts.find(
            (entry) =>
              entry.snapshot?.daemon.capabilities?.scheduled_tasks &&
              entry.status === "encrypted" &&
              entry.presence?.daemon_connected,
          )?.id ?? null);
  const [hostId, setHostId] = useState<string | null>(initialHostId);
  const host = hostId
    ? (hosts.find((entry) => entry.id === hostId) ?? null)
    : null;
  const snapshot = host?.snapshot ?? localSnapshot;
  const workspaces = snapshot?.workspaces ?? [];
  const [workspaceId, setWorkspaceId] = useState(
    editing?.workspace_id ?? workspaces[0]?.id ?? "",
  );
  const workspace =
    workspaces.find((entry) => entry.id === workspaceId) ?? null;
  const providers = workspace?.agents ?? [];
  const [provider, setProvider] = useState<AgentProvider>(
    editing?.provider ?? workspace?.default_provider ?? "codex",
  );
  const agent = providers.find((entry) => entry.provider === provider);
  const [modelId, setModelId] = useState(editing?.model_id ?? "");
  const selectedModel = agent?.models?.find((model) => model.id === modelId);
  const [reasoningEffort, setReasoningEffort] = useState(
    editing?.reasoning_effort ?? "",
  );
  const [collaborationModeId, setCollaborationModeId] = useState(
    editing?.collaboration_mode_id ?? "",
  );
  const [permissionMode, setPermissionMode] = useState(
    editing?.permission_mode ?? "",
  );
  const availableSkills = (workspace?.skills ?? []).filter(
    (skill) =>
      skill.providers.length === 0 || skill.providers.includes(provider),
  );
  const [selectedSkillIds, setSelectedSkillIds] = useState(
    () =>
      new Set(editing?.selected_skills.map((skill) => skill.skill_id) ?? []),
  );
  const [title, setTitle] = useState(editing?.title ?? "");
  const [prompt, setPrompt] = useState(editing?.prompt ?? "");
  const [frequency, setFrequency] = useState<"once" | "daily" | "weekly">(
    editing?.schedule.kind === "once"
      ? "once"
      : editing?.schedule.kind === "recurring" &&
          editing.schedule.rrule.includes("WEEKLY")
        ? "weekly"
        : "daily",
  );
  const recurring = recurringParts(editing);
  const [time, setTime] = useState(recurring.time);
  const initialTimezone =
    editing?.schedule.timezone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone ??
    "UTC";
  const [timezone, setTimezone] = useState(initialTimezone);
  const [runAt, setRunAt] = useState(() => {
    if (editing?.schedule.kind === "once") {
      return utcToWallTime(new Date(editing.schedule.run_at), initialTimezone);
    }
    const date = new Date(Date.now() + 60 * 60 * 1000);
    return utcToWallTime(date, initialTimezone);
  });
  const [weekdays, setWeekdays] = useState(() => new Set(recurring.weekdays));
  const [isolation, setIsolation] = useState<"project_folder" | "isolated">(
    editing?.isolation ?? "project_folder",
  );
  const [sandboxMode, setSandboxMode] = useState(
    editing?.sandbox_mode ?? "workspace-write",
  );
  const [runAfterSave, setRunAfterSave] = useState(false);
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(
    Boolean(
      editing &&
      (editing.model_id ||
        editing.reasoning_effort ||
        editing.collaboration_mode_id ||
        editing.permission_mode ||
        editing.selected_skills.length ||
        editing.isolation !== "project_folder" ||
        (editing.sandbox_mode && editing.sandbox_mode !== "workspace-write")),
    ),
  );

  const switchHost = (value: string) => {
    const nextHostId = value || null;
    setHostId(nextHostId);
    const nextSnapshot = nextHostId
      ? hosts.find((entry) => entry.id === nextHostId)?.snapshot
      : localSnapshot;
    const nextWorkspace = nextSnapshot?.workspaces[0];
    setWorkspaceId(nextWorkspace?.id ?? "");
    setProvider(nextWorkspace?.default_provider ?? "codex");
    setModelId("");
    setReasoningEffort("");
    setCollaborationModeId("");
    setPermissionMode("");
    setSelectedSkillIds(new Set());
  };

  const save = async () => {
    const api = hostApi(hostId, localApi, manager);
    if (!api || !workspaceId) return;
    setSaving(true);
    try {
      const [hour, minute] = time.split(":").map(Number);
      const schedule: CreateScheduledTaskPayload["schedule"] =
        frequency === "once"
          ? { kind: "once", run_at: wallTimeToUtc(runAt, timezone), timezone }
          : {
              kind: "recurring",
              rrule: `FREQ=${frequency === "weekly" ? "WEEKLY" : "DAILY"}${frequency === "weekly" ? `;BYDAY=${[...weekdays].join(",") || "MO"}` : ""};BYHOUR=${hour ?? 9};BYMINUTE=${minute ?? 0}`,
              timezone,
            };
      if (editing) {
        const patch: UpdateScheduledTaskPayload = {
          title,
          prompt,
          workspace_id: workspaceId,
          provider,
          schedule,
          isolation,
          sandbox_mode: sandboxMode,
          model_id: modelId || null,
          reasoning_effort: reasoningEffort || null,
          collaboration_mode_id: collaborationModeId || null,
          permission_mode: permissionMode || null,
          approval_policy: approvalPolicyForProvider(
            provider,
            permissionMode || null,
          ),
          selected_skills: availableSkills
            .filter((skill) => selectedSkillIds.has(skill.id))
            .map((skill) => ({ skill_id: skill.id, alias: skill.alias })),
        };
        await api.updateScheduledTask(editing.id, patch);
      } else {
        if (!workspace) throw new Error("Select a project for this automation.");
        const trigger =
          schedule.kind === "once"
            ? { kind: "once", run_at: schedule.run_at }
            : {
                kind: "cron",
                expression: `${minute ?? 0} ${hour ?? 0} * * ${frequency === "weekly" ? [...weekdays].map((day) => RRULE_TO_CRON_DAY[day] ?? day).join(",") || "MON" : "*"}`,
                timezone,
              };
        const response = await api.controlExecute({
          operation: "automation.create",
          arguments: {
            name: title.trim(),
            trigger,
            task: { kind: "prompt", instruction: prompt },
            target: {
              workspace_path: workspace.path,
              provider,
              thread: { kind: "new_each_run" },
              model_id: modelId || null,
              reasoning_effort: reasoningEffort || null,
              collaboration_mode_id: collaborationModeId || null,
              approval_policy: approvalPolicyForProvider(
                provider,
                permissionMode || null,
              ),
              permission_mode: permissionMode || null,
              sandbox_mode: sandboxMode,
              isolation,
              selected_skills: availableSkills
                .filter((skill) => selectedSkillIds.has(skill.id))
                .map((skill) => skill.id),
            },
            required_connectors: [],
            concurrency_policy: "queue_one",
            misfire_policy:
              schedule.kind === "once" ? "run_once" : "skip",
          },
        });
        if (!response.ok) {
          throw new Error(
            response.error?.suggested_action ??
              response.error?.message ??
              "FalconDeck could not create the automation.",
          );
        }
        const created = response.data as Automation | undefined;
        if (runAfterSave && created?.id) {
          const runResponse = await api.controlExecute({
            operation: "automation.run_now",
            arguments: { automation_id: created.id },
          });
          if (!runResponse.ok) {
            throw new Error(
              runResponse.error?.suggested_action ??
                runResponse.error?.message ??
                "The automation was created but could not be run now.",
            );
          }
        }
      }
      await manager.connection(hostId ?? "")?.refresh();
      onToast({
        variant: "success",
        title: editing ? "Scheduled task updated" : "Scheduled task created",
      });
      onSaved();
    } catch (error) {
      onToast({
        variant: "danger",
        title: "Could not save scheduled task",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/35"
      role="presentation"
      onMouseDown={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="scheduled-task-editor-title"
        className="h-full w-full max-w-2xl overflow-y-auto border-l border-border-subtle bg-surface-1 p-6 shadow-[var(--fd-shadow-lg)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mb-6 flex items-center justify-between">
          <h2
            id="scheduled-task-editor-title"
            className="text-xl font-semibold text-fg-primary"
          >
            {editing ? "Edit scheduled task" : "New scheduled task"}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close editor"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="space-y-6">
          <label className="block">
            <span className="sr-only">Title</span>
            <input
              className="fd-focus w-full border-0 bg-transparent px-0 py-1 text-[length:var(--fd-text-xl)] font-semibold text-fg-primary placeholder:text-fg-muted"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Scheduled task title"
            />
          </label>
          <label className="block">
            <span className="sr-only">Prompt</span>
            <textarea
              className={`${inputClass} min-h-32 resize-y px-4 py-3 text-[length:var(--fd-text-md)]`}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe what the agent should do"
            />
          </label>
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-fg-secondary">
              Details
            </legend>
            <div className="divide-y divide-border-subtle overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-2 px-4">
              {!editing ? (
                <label className="flex min-h-14 items-center gap-4 py-2 text-sm">
                  <span className="font-medium text-fg-primary">Runs on</span>
                  <select
                    className="fd-focus ml-auto max-w-[65%] bg-transparent py-2 text-right text-fg-secondary"
                    aria-label="Execution host"
                    value={hostId ?? ""}
                    onChange={(event) => switchHost(event.target.value)}
                  >
                    <option
                      value=""
                      disabled={
                        !localApi ||
                        !localSnapshot?.daemon.capabilities?.scheduled_tasks
                      }
                    >
                      This Mac
                      {!localApi ||
                      !localSnapshot?.daemon.capabilities?.scheduled_tasks
                        ? " (unavailable)"
                        : ""}
                    </option>
                    {hosts
                      .filter(
                        (entry) =>
                          entry.snapshot?.daemon.capabilities?.scheduled_tasks,
                      )
                      .map((entry) => (
                        <option
                          key={entry.id}
                          value={entry.id}
                          disabled={
                            entry.status !== "encrypted" ||
                            !entry.presence?.daemon_connected
                          }
                        >
                          {entry.name}
                          {entry.status !== "encrypted" ||
                          !entry.presence?.daemon_connected
                            ? " (offline)"
                            : ""}
                        </option>
                      ))}
                  </select>
                </label>
              ) : (
                <div className="flex min-h-14 items-center gap-4 py-2 text-sm">
                  <span className="font-medium text-fg-primary">Runs on</span>
                  <span className="ml-auto text-fg-secondary">
                    {host?.name ?? "This Mac"}
                  </span>
                </div>
              )}
              <label className="flex min-h-14 items-center gap-4 py-2 text-sm">
                <span className="font-medium text-fg-primary">Project</span>
                <select
                  className="fd-focus ml-auto max-w-[65%] bg-transparent py-2 text-right text-fg-secondary"
                  aria-label="Project"
                  value={workspaceId}
                  onChange={(event) => {
                    setWorkspaceId(event.target.value);
                    const next = workspaces.find(
                      (entry) => entry.id === event.target.value,
                    );
                    setProvider(next?.default_provider ?? "codex");
                    setModelId("");
                    setReasoningEffort("");
                    setCollaborationModeId("");
                    setPermissionMode("");
                    setSelectedSkillIds(new Set());
                  }}
                >
                  <option value="" disabled>
                    Select a project
                  </option>
                  {workspaces.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.path.split("/").filter(Boolean).at(-1) ??
                        entry.path}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-h-14 items-center gap-4 py-2 text-sm">
                <span className="font-medium text-fg-primary">Agent</span>
                <select
                  className="fd-focus ml-auto max-w-[65%] bg-transparent py-2 text-right text-fg-secondary"
                  aria-label="Agent"
                  value={provider}
                  onChange={(event) => {
                    setProvider(event.target.value as AgentProvider);
                    setModelId("");
                    setReasoningEffort("");
                    setCollaborationModeId("");
                    setSelectedSkillIds(new Set());
                  }}
                >
                  {providers.map((entry) => (
                    <option key={entry.provider} value={entry.provider}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-fg-secondary">
              Frequency
            </legend>
            <div className="divide-y divide-border-subtle overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-2 px-4">
              <label className="flex min-h-14 items-center gap-4 py-2 text-sm">
                <span className="font-medium text-fg-primary">Repeat</span>
                <select
                  className="fd-focus ml-auto bg-transparent py-2 text-right text-fg-secondary"
                  aria-label="Repeat"
                  value={frequency}
                  onChange={(event) =>
                    setFrequency(event.target.value as typeof frequency)
                  }
                >
                  <option value="once">Once</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
              </label>
              <label className="flex min-h-14 items-center gap-4 py-2 text-sm">
                <span className="font-medium text-fg-primary">
                  {frequency === "once" ? "Run at" : "At"}
                </span>
                <input
                  type={frequency === "once" ? "datetime-local" : "time"}
                  className="fd-focus ml-auto bg-transparent py-2 text-right text-fg-secondary"
                  aria-label={frequency === "once" ? "Run at" : "Time"}
                  value={frequency === "once" ? runAt : time}
                  onChange={(event) =>
                    frequency === "once"
                      ? setRunAt(event.target.value)
                      : setTime(event.target.value)
                  }
                />
              </label>
              {frequency === "weekly" ? (
                <fieldset className="flex min-h-14 items-center gap-4 py-2">
                  <legend className="sr-only">Days</legend>
                  <span className="text-sm font-medium text-fg-primary">
                    Days
                  </span>
                  <div className="ml-auto flex flex-wrap justify-end gap-1.5">
                    {[
                      ["MO", "Mon"],
                      ["TU", "Tue"],
                      ["WE", "Wed"],
                      ["TH", "Thu"],
                      ["FR", "Fri"],
                      ["SA", "Sat"],
                      ["SU", "Sun"],
                    ].map(([value, label]) => (
                      <label
                        key={value}
                        className={cn(
                          "fd-focus cursor-pointer rounded-[var(--fd-radius-sm)] border px-2 py-1 text-[length:var(--fd-text-xs)]",
                          weekdays.has(value)
                            ? "border-accent/40 bg-accent-muted text-accent-strong"
                            : "border-border-subtle text-fg-secondary",
                        )}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={weekdays.has(value)}
                          onChange={(event) =>
                            setWeekdays((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(value);
                              else next.delete(value);
                              return next;
                            })
                          }
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              <div className="flex min-h-14 items-center gap-4 py-2 text-sm">
                <span className="font-medium text-fg-primary">
                  Notifications
                </span>
                <span className="ml-auto text-right text-fg-secondary">
                  FalconDeck settings
                </span>
              </div>
            </div>
          </fieldset>

          <div className="overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2">
            <button
              type="button"
              className="fd-focus flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-fg-primary"
              aria-expanded={advancedOpen}
              aria-controls="scheduled-task-advanced"
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              Advanced
              <ChevronDown
                aria-hidden
                className={cn(
                  "h-4 w-4 text-fg-muted transition-transform",
                  advancedOpen ? "rotate-180" : "",
                )}
              />
            </button>
            {advancedOpen ? (
              <div
                id="scheduled-task-advanced"
                className="space-y-5 border-t border-border-subtle p-4"
              >
                {agent?.models?.length ? (
                  <label className="block text-sm font-medium text-fg-secondary">
                    Model
                    <select
                      className={`${inputClass} mt-1.5`}
                      value={modelId}
                      onChange={(event) => setModelId(event.target.value)}
                    >
                      <option value="">Agent default</option>
                      {agent.models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {selectedModel?.supported_reasoning_efforts.length ? (
                  <label className="block text-sm font-medium text-fg-secondary">
                    Reasoning
                    <select
                      className={`${inputClass} mt-1.5`}
                      value={reasoningEffort}
                      onChange={(event) =>
                        setReasoningEffort(event.target.value)
                      }
                    >
                      <option value="">Model default</option>
                      {selectedModel.supported_reasoning_efforts.map(
                        (effort) => (
                          <option
                            key={effort.reasoning_effort}
                            value={effort.reasoning_effort}
                          >
                            {effort.description}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                ) : null}
                {agent?.collaboration_modes?.length ? (
                  <label className="block text-sm font-medium text-fg-secondary">
                    Mode
                    <select
                      className={`${inputClass} mt-1.5`}
                      value={collaborationModeId}
                      onChange={(event) =>
                        setCollaborationModeId(event.target.value)
                      }
                    >
                      <option value="">Default</option>
                      {agent.collaboration_modes.map((mode) => (
                        <option key={mode.id} value={mode.id}>
                          {mode.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {availableSkills.length ? (
                  <fieldset>
                    <legend className="text-sm font-medium text-fg-secondary">
                      Skills
                    </legend>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {availableSkills.map((skill) => (
                        <label
                          key={skill.id}
                          className="flex items-center gap-2 rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2 px-3 py-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={selectedSkillIds.has(skill.id)}
                            onChange={(event) =>
                              setSelectedSkillIds((current) => {
                                const next = new Set(current);
                                if (event.target.checked) next.add(skill.id);
                                else next.delete(skill.id);
                                return next;
                              })
                            }
                          />
                          {skill.label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ) : null}
                <label className="block text-sm font-medium text-fg-secondary">
                  Timezone
                  <input
                    className={`${inputClass} mt-1.5`}
                    list="scheduled-task-timezones"
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                    placeholder="Europe/London"
                  />
                  <datalist id="scheduled-task-timezones">
                    <option value="UTC" />
                    <option value="Europe/London" />
                    <option value="America/New_York" />
                    <option value="America/Los_Angeles" />
                    <option value="Asia/Tokyo" />
                    <option value="Australia/Sydney" />
                  </datalist>
                </label>
                <label className="block text-sm font-medium text-fg-secondary">
                  Checkout
                  <select
                    className={`${inputClass} mt-1.5`}
                    value={isolation}
                    onChange={(event) =>
                      setIsolation(event.target.value as typeof isolation)
                    }
                  >
                    <option value="project_folder">Project folder</option>
                    <option value="isolated">
                      Isolated checkout (recommended for recurring changes)
                    </option>
                  </select>
                </label>
                {provider === "codex" ? (
                  <label className="block text-sm font-medium text-fg-secondary">
                    Sandbox
                    <select
                      className={`${inputClass} mt-1.5`}
                      value={sandboxMode}
                      onChange={(event) => setSandboxMode(event.target.value)}
                    >
                      <option value="workspace-write">Workspace write</option>
                      <option value="read-only">Read only</option>
                      <option value="danger-full-access">Full access</option>
                    </select>
                  </label>
                ) : null}
                {agent?.capabilities?.permission_modes.length ? (
                  <label className="block text-sm font-medium text-fg-secondary">
                    Permissions
                    <select
                      className={`${inputClass} mt-1.5`}
                      value={permissionMode}
                      onChange={(event) =>
                        setPermissionMode(event.target.value)
                      }
                    >
                      <option value="">Provider default</option>
                      {agent.capabilities.permission_modes.map((mode) => (
                        <option key={mode} value={mode}>
                          {mode}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {!editing ? (
                  <label className="flex items-center gap-2 text-sm text-fg-secondary">
                    <input
                      type="checkbox"
                      checked={runAfterSave}
                      onChange={(event) =>
                        setRunAfterSave(event.target.checked)
                      }
                    />
                    Run once now after saving
                  </label>
                ) : null}
              </div>
            ) : null}
          </div>

          {isolation === "project_folder" ||
          sandboxMode === "danger-full-access" ? (
            <p className="rounded-[var(--fd-radius-md)] border border-warning/25 bg-warning-muted p-3 text-sm text-warning">
              This automation can modify a live checkout without you present.
              Review its prompt and permissions carefully.
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => void save()}
              disabled={
                saving ||
                !title.trim() ||
                !prompt.trim() ||
                !workspaceId ||
                !timezone.trim() ||
                (frequency === "once" && !runAt)
              }
            >
              {saving ? "Saving…" : "Save task"}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function ScheduledTasksView({
  localSnapshot,
  localApi,
  localBaseUrl,
  hosts,
  manager,
  onRefreshLocal,
  onCreateWithAgent,
  onOpenThread,
  onToast,
}: {
  localSnapshot: DaemonSnapshot | null;
  localApi: HostScopedApi | null;
  localBaseUrl: string | null;
  hosts: HostView[];
  manager: HostManager;
  onRefreshLocal: () => Promise<void>;
  onCreateWithAgent?: () => void;
  onOpenThread: (workspaceId: string, threadId: string) => void;
  onToast: Toast;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "paused">("all");
  const [hostFilter, setHostFilter] = useState("all");
  const [selected, setSelected] = useState<TaskEntry | null>(null);
  const [selectedDetail, setSelectedDetail] =
    useState<ScheduledTaskDetail | null>(null);
  const [selectedRuns, setSelectedRuns] = useState<ScheduledTaskRunSummary[]>(
    [],
  );
  const [selectedAutomation, setSelectedAutomation] =
    useState<Automation | null>(null);
  const [selectedAutomationRuns, setSelectedAutomationRuns] = useState<
    AutomationRun[]
  >([]);
  const [editor, setEditor] = useState<LegacyEditorState>(null);
  const [automationEditor, setAutomationEditor] =
    useState<AutomationEditorSelection | null>(null);
  const [automationsByHost, setAutomationsByHost] = useState<
    Record<
      string,
      { automations: Automation[]; settings: AgentControlSettings | null }
    >
  >({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const detailRequest = useRef(0);
  const editorRequest = useRef(0);

  const closeDetail = () => {
    detailRequest.current += 1;
    setSelected(null);
    setSelectedDetail(null);
    setSelectedRuns([]);
    setSelectedAutomation(null);
    setSelectedAutomationRuns([]);
  };

  const closeEditor = () => {
    editorRequest.current += 1;
    setEditor(null);
  };

  const loadAutomations = useCallback(
    async (key: string, scopedApi: HostScopedApi) => {
      try {
        const [automationResponse, settingsResponse] = await Promise.all([
          scopedApi.controlGet({ resource: "automations", limit: 100 }),
          scopedApi
            .controlGet({ resource: "agent_control.settings" })
            .catch(() => null),
        ]);
        const automations = Array.isArray(automationResponse.data)
          ? (automationResponse.data as Automation[]).filter(
              (automation) =>
                typeof automation?.id === "string" &&
                typeof automation?.name === "string" &&
                typeof automation?.revision === "number",
            )
          : [];
        setAutomationsByHost((current) => ({
          ...current,
          [key]: {
            automations,
            settings: settingsResponse
              ? (settingsResponse.data as AgentControlSettings)
              : null,
          },
        }));
      } catch (error) {
        onToast({
          variant: "danger",
          title: "Could not load scheduled automations",
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [onToast],
  );

  useEffect(() => {
    if (localApi) void loadAutomations("local", localApi);
  }, [loadAutomations, localApi]);

  const remoteControlRevisionKey = hosts
    .map(
      (host) =>
        `${host.id}:${host.controlRevision ?? 0}:${host.status}:${Boolean(host.presence?.daemon_connected)}`,
    )
    .join("|");
  useEffect(() => {
    for (const host of hosts) {
      if (
        host.status !== "encrypted" ||
        !host.presence?.daemon_connected
      ) {
        continue;
      }
      const scopedApi = manager.connection(host.id)?.scheduledApi();
      if (scopedApi) void loadAutomations(host.id, scopedApi);
    }
  }, [hosts, loadAutomations, manager, remoteControlRevisionKey]);

  useControlStateEvents(localBaseUrl, (_revision, domains) => {
    if (
      localApi &&
      (domains.includes("automations") || domains.includes("runs"))
    ) {
      void loadAutomations("local", localApi);
    }
  });

  const openCreateEditor = () => {
    editorRequest.current += 1;
    setEditor({ kind: "create" });
  };

  const entries = useMemo(() => {
    const local: TaskEntry[] = (localSnapshot?.scheduled_tasks ?? []).map(
      (task) => ({
        hostId: null,
        hostName: "This Mac",
        online: Boolean(localApi),
        supported: localSnapshot?.daemon.capabilities?.scheduled_tasks ?? false,
        workspaces: localSnapshot?.workspaces ?? [],
        task,
        automation: null,
      }),
    );
    const remote = hosts.flatMap((host): TaskEntry[] =>
      (host.snapshot?.scheduled_tasks ?? []).map((task) => ({
        hostId: host.id,
        hostName: host.name,
        online:
          host.status === "encrypted" &&
          Boolean(host.presence?.daemon_connected),
        supported: host.snapshot?.daemon.capabilities?.scheduled_tasks ?? false,
        workspaces: host.snapshot?.workspaces ?? [],
        task,
        automation: null,
      })),
    );
    const automationEntries = Object.entries(automationsByHost).flatMap(
      ([hostKey, state]): TaskEntry[] => {
        const host = hostKey === "local"
          ? null
          : (hosts.find((candidate) => candidate.id === hostKey) ?? null);
        const snapshot = host?.snapshot ?? localSnapshot;
        const workspaces = snapshot?.workspaces ?? [];
        return state.automations.map((automation) => ({
          hostId: host?.id ?? null,
          hostName: host?.name ?? "This Mac",
          online: host
            ? host.status === "encrypted" &&
              Boolean(host.presence?.daemon_connected)
            : Boolean(localApi),
          // Successfully loading the record proves this daemon exposes the
          // control API even if an older snapshot predates that capability.
          supported: true,
          workspaces,
          task: automationAsScheduledTask(automation, workspaces),
          automation,
        }));
      },
    );
    const automationKeys = new Set(
      automationEntries.map((entry) => taskEntryKey(entry)),
    );
    return [
      ...local.filter((entry) => !automationKeys.has(taskEntryKey(entry))),
      ...remote.filter((entry) => !automationKeys.has(taskEntryKey(entry))),
      ...automationEntries,
    ];
  }, [automationsByHost, hosts, localApi, localSnapshot]);
  const visible = entries.filter((entry) => {
    const workspace = entry.workspaces.find(
      (item) => item.id === entry.task.workspace_id,
    );
    const haystack =
      `${entry.task.title} ${entry.task.prompt_preview} ${entry.task.provider} ${entry.hostName} ${workspace?.path ?? ""}`.toLowerCase();
    return (
      (filter === "all" || entry.task.status === filter) &&
      (hostFilter === "all" || (entry.hostId ?? "local") === hostFilter) &&
      haystack.includes(query.trim().toLowerCase())
    );
  });
  const unsupportedHosts = hosts.filter(
    (host) =>
      host.snapshot && !host.snapshot.daemon.capabilities?.scheduled_tasks,
  );
  const canCreate = Boolean(
    (localApi && localSnapshot?.daemon.capabilities?.scheduled_tasks) ||
    hosts.some(
      (host) =>
        host.snapshot?.daemon.capabilities?.scheduled_tasks &&
        host.status === "encrypted" &&
        host.presence?.daemon_connected,
    ),
  );

  const mutate = async (
    entry: TaskEntry,
    action: "run" | "toggle" | "delete",
  ) => {
    const api = hostApi(entry.hostId, localApi, manager);
    if (!api) return;
    const selectionVersion = detailRequest.current;
    setBusyKey(taskEntryKey(entry));
    try {
      if (action === "delete") {
        if (
          !window.confirm(
            `Delete “${entry.task.title}”? Generated agent tasks will be kept.`,
          )
        )
          return;
      }
      if (entry.automation) {
        const operation =
          action === "run"
            ? "automation.run_now"
            : action === "delete"
              ? "automation.delete"
              : entry.automation.state === "paused"
                ? "automation.resume"
                : "automation.pause";
        const response = await api.controlExecute({
          operation,
          arguments: { automation_id: entry.automation.id },
          ...(action === "run"
            ? {}
            : { expected_revision: entry.automation.revision }),
        });
        if (!response.ok) throw new Error(controlErrorMessage(response));
        if (action === "delete") closeDetail();
        await loadAutomations(entry.hostId ?? "local", api);
      } else {
        if (action === "run") await api.runScheduledTask(entry.task.id);
        if (action === "toggle") {
          await api.updateScheduledTask(entry.task.id, {
            status: entry.task.status === "paused" ? "active" : "paused",
          });
        }
        if (action === "delete") {
          await api.deleteScheduledTask(entry.task.id);
          closeDetail();
        }
        if (entry.hostId) await manager.connection(entry.hostId)?.refresh();
        else await onRefreshLocal();
      }
      if (
        action !== "delete" &&
        selected &&
        taskEntryKey(selected) === taskEntryKey(entry) &&
        detailRequest.current === selectionVersion
      ) {
        if (entry.automation) {
          const [detailResponse, runsResponse] = await Promise.all([
            api.controlGet({ resource: "automation", id: entry.automation.id }),
            api.controlGet({
              resource: "automation.runs",
              id: entry.automation.id,
              limit: 100,
            }),
          ]);
          if (detailRequest.current === selectionVersion) {
            const detail = detailResponse.data as Automation;
            setSelected({
              ...entry,
              task: automationAsScheduledTask(detail, entry.workspaces),
              automation: detail,
            });
            setSelectedAutomation(detail);
            setSelectedAutomationRuns(
              Array.isArray(runsResponse.data)
                ? (runsResponse.data as AutomationRun[])
                : [],
            );
          }
          return;
        }
        const [detail, runs] = await Promise.all([
          api.scheduledTask(entry.task.id),
          api.scheduledTaskRuns(entry.task.id),
        ]);
        if (detailRequest.current === selectionVersion) {
          setSelected({ ...entry, task: detail });
          setSelectedDetail(detail);
          setSelectedRuns(runs);
        }
      }
    } catch (error) {
      onToast({
        variant: "danger",
        title: "Scheduled task action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyKey(null);
    }
  };

  const edit = async (entry: TaskEntry) => {
    const api = hostApi(entry.hostId, localApi, manager);
    if (!api) return;
    const request = editorRequest.current + 1;
    editorRequest.current = request;
    setBusyKey(taskEntryKey(entry));
    try {
      if (entry.automation) {
        const response = await api.controlGet({
          resource: "automation",
          id: entry.automation.id,
        });
        if (editorRequest.current === request) {
          setAutomationEditor({
            entry,
            automation: response.data as Automation,
          });
        }
        return;
      }
      const detail = await api.scheduledTask(entry.task.id);
      if (editorRequest.current === request) {
        setEditor({ kind: "edit", entry, detail });
      }
    } catch (error) {
      if (editorRequest.current !== request) return;
      onToast({
        variant: "danger",
        title: "Could not load scheduled task",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (editorRequest.current === request) setBusyKey(null);
    }
  };

  const openDetail = (entry: TaskEntry) => {
    const request = detailRequest.current + 1;
    detailRequest.current = request;
    setSelected(entry);
    setSelectedDetail(null);
    setSelectedRuns([]);
    setSelectedAutomation(null);
    setSelectedAutomationRuns([]);
    if (!entry.online || !entry.supported) return;
    const api = hostApi(entry.hostId, localApi, manager);
    if (!api) return;
    const requestDetails = entry.automation
      ? Promise.all([
          api.controlGet({ resource: "automation", id: entry.automation.id }),
          api.controlGet({
            resource: "automation.runs",
            id: entry.automation.id,
            limit: 100,
          }),
        ])
      : Promise.all([
          api.scheduledTask(entry.task.id),
          api.scheduledTaskRuns(entry.task.id),
        ]);
    void requestDetails
      .then(([detailResponse, runsResponse]) => {
        if (detailRequest.current !== request) return;
        if (entry.automation) {
          setSelectedAutomation(
            (detailResponse as Awaited<ReturnType<HostScopedApi["controlGet"]>>)
              .data as Automation,
          );
          const data = (
            runsResponse as Awaited<ReturnType<HostScopedApi["controlGet"]>>
          ).data;
          setSelectedAutomationRuns(
            Array.isArray(data) ? (data as AutomationRun[]) : [],
          );
        } else {
          setSelectedDetail(detailResponse as ScheduledTaskDetail);
          setSelectedRuns(runsResponse as ScheduledTaskRunSummary[]);
        }
      })
      .catch((error) => {
        if (detailRequest.current !== request) return;
        onToast({
          variant: "danger",
          title: "Could not load scheduled task details",
          description: error instanceof Error ? error.message : String(error),
        });
      });
  };

  return (
    <main className="h-full overflow-y-auto bg-surface-1 px-8 py-10 text-fg-primary">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">
              Scheduled tasks
            </h1>
            <p className="mt-2 text-fg-secondary">
              Run recurring agent work on this Mac or an enrolled server.
            </p>
          </div>
          <div className="flex">
            <Button
              className="rounded-r-none"
              onClick={onCreateWithAgent}
              disabled={!onCreateWithAgent}
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              New task
            </Button>
            <Popover.Root>
              <Popover.Trigger asChild>
                <Button
                  className="rounded-l-none border-l border-surface-0 px-2"
                  aria-haspopup="menu"
                  aria-label="New task options"
                  disabled={!onCreateWithAgent && !canCreate}
                >
                  <ChevronDown aria-hidden="true" className="h-4 w-4" />
                </Button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  align="end"
                  sideOffset={8}
                  role="menu"
                  aria-label="New task options"
                  onKeyDown={handleMenuKeyDown}
                  className="z-50 min-w-52 rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2 p-1 shadow-[var(--fd-shadow-md)]"
                >
                  <Popover.Close asChild>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!onCreateWithAgent}
                      className="fd-focus flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-fg-primary hover:bg-surface-3 disabled:opacity-40"
                      onClick={onCreateWithAgent}
                    >
                      <MessageCircle aria-hidden="true" className="h-4 w-4" />
                      Create with agent
                    </button>
                  </Popover.Close>
                  <Popover.Close asChild>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!canCreate}
                      className="fd-focus flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-fg-primary hover:bg-surface-3 disabled:opacity-40"
                      onClick={openCreateEditor}
                    >
                      <Pencil aria-hidden="true" className="h-4 w-4" />
                      Set up manually
                    </button>
                  </Popover.Close>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>
        </div>
        <label className="relative mt-8 block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
          <span className="sr-only">Search scheduled tasks</span>
          <input
            className={`${inputClass} pl-10`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search scheduled tasks"
          />
        </label>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div
            className="flex gap-1"
            role="group"
            aria-label="Task status filter"
          >
            {(["all", "active", "paused"] as const).map((value) => (
              <button
                key={value}
                className={cn(
                  "fd-focus rounded-[var(--fd-radius-md)] px-3 py-1.5 text-sm capitalize text-fg-secondary",
                  filter === value && "bg-surface-3 text-fg-primary",
                )}
                onClick={() => setFilter(value)}
              >
                {value}
              </button>
            ))}
          </div>
          {hosts.length ? (
            <select
              aria-label="Host filter"
              className={`${inputClass} w-auto`}
              value={hostFilter}
              onChange={(event) => setHostFilter(event.target.value)}
            >
              <option value="all">All hosts</option>
              <option value="local">This Mac</option>
              {hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        {unsupportedHosts.length ? (
          <p className="mt-4 rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2 px-4 py-3 text-sm text-warning">
            Scheduled tasks are unavailable on{" "}
            {unsupportedHosts.map((host) => host.name).join(", ")}
            {unsupportedHosts.length === 1
              ? " until its daemon is upgraded."
              : " until their daemons are upgraded."}
          </p>
        ) : null}
        {localSnapshot &&
        !localSnapshot.daemon.capabilities?.scheduled_tasks ? (
          <p className="mt-4 rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2 px-4 py-3 text-sm text-warning">
            Scheduled tasks are unavailable on This Mac until its daemon is
            upgraded.
          </p>
        ) : null}
        {!localSnapshot ? (
          <p className="mt-10 text-center text-sm text-fg-muted">
            Loading scheduled tasks…
          </p>
        ) : null}
        <div className="mt-6 divide-y divide-border-subtle">
          {visible.map((entry) => {
            const workspace = entry.workspaces.find(
              (item) => item.id === entry.task.workspace_id,
            );
            const key = `${entry.hostId ?? "local"}:${entry.task.id}`;
            return (
              <article
                key={key}
                className="group relative flex items-start gap-3 py-4"
              >
                <button
                  className="fd-focus mt-1 rounded-full"
                  aria-label={`Open ${entry.task.title}`}
                  onClick={() => openDetail(entry)}
                >
                  {entry.task.last_run?.status === "failed" ? (
                    <CircleAlert className="h-4 w-4 text-danger" />
                  ) : entry.task.last_run?.status === "awaiting_input" ? (
                    <CircleAlert className="h-4 w-4 text-warning" />
                  ) : entry.task.status === "active" ? (
                    <Clock3 className="h-4 w-4 text-info" />
                  ) : (
                    <span className="block h-4 w-4 rounded-full border border-fg-muted" />
                  )}
                </button>
                <button
                  className="fd-focus min-w-0 flex-1 rounded text-left"
                  onClick={() => openDetail(entry)}
                >
                  <h2 className="truncate font-medium">{entry.task.title}</h2>
                  <p className="mt-1 truncate text-sm text-fg-muted">
                    {humanSchedule(entry)} · {nextRunLabel(entry)} ·{" "}
                    {workspace?.path.split("/").filter(Boolean).at(-1) ??
                      "Unknown project"}{" "}
                    · {entry.task.provider} · {entry.hostName}
                    {entry.task.last_run?.status === "failed"
                      ? " · Last run failed"
                      : entry.task.last_run?.status === "awaiting_input"
                        ? " · Waiting for input"
                        : ""}
                  </p>
                </button>
                <div className="flex opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Run ${entry.task.title} now`}
                    disabled={!entry.online || busyKey === key}
                    onClick={() => void mutate(entry, "run")}
                  >
                    <Play className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${entry.task.status === "paused" ? "Resume" : "Pause"} ${entry.task.title}`}
                    disabled={
                      !entry.online ||
                      busyKey === key ||
                      entry.task.status === "completed"
                    }
                    onClick={() => void mutate(entry, "toggle")}
                  >
                    {entry.task.status === "paused" ? (
                      <Play className="h-4 w-4" />
                    ) : (
                      <Pause className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-haspopup="menu"
                    aria-expanded={menuKey === key}
                    aria-label={`More actions for ${entry.task.title}`}
                    onClick={() =>
                      setMenuKey((current) => (current === key ? null : key))
                    }
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </div>
                {menuKey === key ? (
                  <div
                    role="menu"
                    aria-label={`Actions for ${entry.task.title}`}
                    onKeyDown={(event) =>
                      handleMenuKeyDown(event, () => setMenuKey(null))
                    }
                    className="absolute right-0 top-12 z-20 min-w-40 rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2 p-1 shadow-[var(--fd-shadow-md)]"
                  >
                    <button
                      role="menuitem"
                      className="fd-focus block w-full rounded px-3 py-2 text-left text-sm hover:bg-surface-3"
                      disabled={!entry.online}
                      onClick={() => {
                        setMenuKey(null);
                        void mutate(entry, "run");
                      }}
                    >
                      Run now
                    </button>
                    <button
                      role="menuitem"
                      className="fd-focus block w-full rounded px-3 py-2 text-left text-sm hover:bg-surface-3"
                      disabled={!entry.online}
                      onClick={() => {
                        setMenuKey(null);
                        void edit(entry);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      role="menuitem"
                      className="fd-focus block w-full rounded px-3 py-2 text-left text-sm hover:bg-surface-3"
                      disabled={
                        !entry.online || entry.task.status === "completed"
                      }
                      onClick={() => {
                        setMenuKey(null);
                        void mutate(entry, "toggle");
                      }}
                    >
                      {entry.task.status === "paused" ? "Resume" : "Pause"}
                    </button>
                    <button
                      role="menuitem"
                      className="fd-focus block w-full rounded px-3 py-2 text-left text-sm text-danger hover:bg-surface-3"
                      disabled={!entry.online}
                      onClick={() => {
                        setMenuKey(null);
                        void mutate(entry, "delete");
                      }}
                    >
                      Delete
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
          {localSnapshot && visible.length === 0 ? (
            <div className="py-20 text-center">
              <CalendarClock className="mx-auto h-8 w-8 text-fg-muted" />
              <h2 className="mt-3 font-medium">
                {entries.length
                  ? "No matching tasks"
                  : "No scheduled tasks yet"}
              </h2>
              <p className="mt-1 text-sm text-fg-muted">
                {entries.length
                  ? "Try another search or filter."
                  : "Create one to run agent work automatically."}
              </p>
            </div>
          ) : null}
        </div>
      </div>
      {selected ? (
        <aside
          role="dialog"
          aria-modal="true"
          aria-labelledby="scheduled-task-detail-title"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              closeDetail();
            }
          }}
          className="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto border-l border-border-subtle bg-surface-1 p-6 shadow-[var(--fd-shadow-lg)]"
        >
          <div className="flex justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-fg-muted">
                {selected.hostName}
              </p>
              <h2
                id="scheduled-task-detail-title"
                className="mt-1 text-xl font-semibold"
              >
                {selected.task.title}
              </h2>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                closeDetail();
              }}
              aria-label="Close task details"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <dl className="mt-6 space-y-4 text-sm">
            <div>
              <dt className="text-fg-muted">Schedule</dt>
              <dd className="mt-1">{humanSchedule(selected)}</dd>
            </div>
            <div>
              <dt className="text-fg-muted">Next run</dt>
              <dd className="mt-1">{nextRunLabel(selected)}</dd>
            </div>
            <div>
              <dt className="text-fg-muted">Provider</dt>
              <dd className="mt-1 capitalize">
                {selected.task.provider}
                {(selectedAutomation?.target.model_id ?? selectedDetail?.model_id)
                  ? ` · ${selectedAutomation?.target.model_id ?? selectedDetail?.model_id}`
                  : ""}
              </dd>
            </div>
            {selectedAutomation ? (
              <>
                <div>
                  <dt className="text-fg-muted">Prompt</dt>
                  <dd className="mt-1 whitespace-pre-wrap text-fg-secondary">
                    {selectedAutomation.task.instruction}
                  </dd>
                  {selectedAutomation.task.kind === "conditional_prompt" ? (
                    <dd className="mt-1 text-xs text-fg-muted">
                      No-action marker: {selectedAutomation.task.no_action_marker}
                    </dd>
                  ) : null}
                </div>
                <div>
                  <dt className="text-fg-muted">Execution</dt>
                  <dd className="mt-1 text-fg-secondary">
                    {selectedAutomation.target.isolation === "isolated"
                      ? "Isolated checkout"
                      : "Project folder"}
                    {selectedAutomation.target.sandbox_mode
                      ? ` · ${selectedAutomation.target.sandbox_mode}`
                      : ""}
                    {selectedAutomation.target.permission_mode
                      ? ` · ${selectedAutomation.target.permission_mode}`
                      : ""}
                    {` · ${selectedAutomation.target.thread.kind.replaceAll("_", " ")}`}
                  </dd>
                </div>
                {selectedAutomation.target.selected_skills?.length ? (
                  <div>
                    <dt className="text-fg-muted">Skills</dt>
                    <dd className="mt-1 text-fg-secondary">
                      {selectedAutomation.target.selected_skills.join(", ")}
                    </dd>
                  </div>
                ) : null}
                {selectedAutomation.required_connectors.length ? (
                  <div>
                    <dt className="text-fg-muted">Required connectors</dt>
                    <dd className="mt-1 text-fg-secondary">
                      {selectedAutomation.required_connectors.join(", ")}
                    </dd>
                  </div>
                ) : null}
              </>
            ) : selectedDetail ? (
              <>
                <div>
                  <dt className="text-fg-muted">Prompt</dt>
                  <dd className="mt-1 whitespace-pre-wrap text-fg-secondary">
                    {selectedDetail.prompt}
                  </dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Execution</dt>
                  <dd className="mt-1 text-fg-secondary">
                    {selectedDetail.isolation === "isolated"
                      ? "Isolated checkout"
                      : "Project folder"}
                    {selectedDetail.sandbox_mode
                      ? ` · ${selectedDetail.sandbox_mode}`
                      : ""}
                    {selectedDetail.permission_mode
                      ? ` · ${selectedDetail.permission_mode}`
                      : ""}
                  </dd>
                </div>
                {selectedDetail.selected_skills.length ? (
                  <div>
                    <dt className="text-fg-muted">Skills</dt>
                    <dd className="mt-1 text-fg-secondary">
                      {selectedDetail.selected_skills
                        .map((skill) => skill.alias ?? skill.skill_id)
                        .join(", ")}
                    </dd>
                  </div>
                ) : null}
              </>
            ) : selected.online && selected.supported ? (
              <div>
                <dt className="text-fg-muted">Details</dt>
                <dd className="mt-1 text-fg-secondary">Loading…</dd>
              </div>
            ) : null}
            {selected.task.last_run ? (
              <div>
                <dt className="text-fg-muted">Latest run</dt>
                <dd className="mt-1 capitalize">
                  {selected.task.last_run.status.replace("_", " ")}
                </dd>
                {selected.task.last_run.preview ? (
                  <dd className="mt-1 text-fg-secondary">
                    {selected.task.last_run.preview}
                  </dd>
                ) : null}
              </div>
            ) : null}
          </dl>
          {(selectedAutomationRuns.find((run) => run.thread_id)?.thread_id ??
            selected.task.last_run?.thread_id) ? (
            <Button
              className="mt-6 w-full"
              variant="outline"
              onClick={() => {
                const automationRun = selectedAutomationRuns.find(
                  (run) => run.thread_id,
                );
                onOpenThread(
                  automationRun?.runtime_workspace_id ??
                    selected.task.workspace_id,
                  automationRun?.thread_id ??
                    selected.task.last_run!.thread_id!,
                );
              }}
            >
              Open latest thread
            </Button>
          ) : null}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              onClick={() => void edit(selected)}
              disabled={!selected.online || !selected.supported}
            >
              Edit
            </Button>
            <Button
              variant="outline"
              onClick={() => void mutate(selected, "run")}
              disabled={!selected.online || !selected.supported}
            >
              Run now
            </Button>
            <Button
              variant="outline"
              onClick={() => void mutate(selected, "toggle")}
              disabled={
                !selected.online ||
                !selected.supported ||
                selected.task.status === "completed"
              }
            >
              {selected.task.status === "paused" ? "Resume" : "Pause"}
            </Button>
            <Button
              variant="outline"
              className="text-danger"
              onClick={() => void mutate(selected, "delete")}
              disabled={!selected.online || !selected.supported}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
          </div>
          {selectedRuns.length ? (
            <section className="mt-8">
              <h3 className="text-sm font-medium">Recent runs</h3>
              <ol className="mt-2 divide-y divide-border-subtle">
                {selectedRuns.map((run) => (
                  <li key={run.id} className="py-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="capitalize">
                        {run.status.replace("_", " ")}
                      </span>
                      <time className="text-xs text-fg-muted">
                        {new Date(run.scheduled_for).toLocaleString()}
                      </time>
                    </div>
                    {run.preview ? (
                      <p className="mt-1 line-clamp-2 text-fg-secondary">
                        {run.preview}
                      </p>
                    ) : null}
                    {run.thread_id ? (
                      <button
                        className="fd-focus mt-1 rounded text-xs text-info hover:underline"
                        onClick={() =>
                          onOpenThread(run.workspace_id, run.thread_id!)
                        }
                      >
                        Open thread
                      </button>
                    ) : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          {selectedAutomationRuns.length ? (
            <section className="mt-8">
              <h3 className="text-sm font-medium">Recent runs</h3>
              <ol className="mt-2 divide-y divide-border-subtle">
                {selectedAutomationRuns.map((run) => (
                  <li key={run.id} className="py-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="capitalize">
                        {run.status.replaceAll("_", " ")}
                      </span>
                      <time className="text-xs text-fg-muted">
                        {new Date(
                          run.scheduled_for ?? run.queued_at,
                        ).toLocaleString()}
                      </time>
                    </div>
                    {run.outcome_preview ?? run.error?.message ? (
                      <p className="mt-1 line-clamp-2 text-fg-secondary">
                        {run.outcome_preview ?? run.error?.message}
                      </p>
                    ) : null}
                    {run.thread_id && run.runtime_workspace_id ? (
                      <button
                        className="fd-focus mt-1 rounded text-xs text-info hover:underline"
                        onClick={() =>
                          onOpenThread(
                            run.runtime_workspace_id!,
                            run.thread_id!,
                          )
                        }
                      >
                        Open thread
                      </button>
                    ) : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          {!selected.supported ? (
            <p className="mt-4 rounded bg-surface-2 p-3 text-sm text-warning">
              This daemon does not support scheduled tasks yet. Upgrade
              FalconDeck on this host to manage it.
            </p>
          ) : !selected.online ? (
            <p className="mt-4 rounded bg-surface-2 p-3 text-sm text-warning">
              This host is offline. Its daemon will continue running existing
              schedules, but changes are unavailable until it reconnects.
            </p>
          ) : null}
        </aside>
      ) : null}
      {editor ? (
        <TaskEditor
          state={editor}
          localSnapshot={localSnapshot}
          hosts={hosts}
          localApi={localApi}
          manager={manager}
          onClose={closeEditor}
          onSaved={() => {
            closeEditor();
            void onRefreshLocal();
            if (localApi) void loadAutomations("local", localApi);
            for (const host of hosts) {
              const scopedApi = manager.connection(host.id)?.scheduledApi();
              if (scopedApi) void loadAutomations(host.id, scopedApi);
            }
          }}
          onToast={onToast}
        />
      ) : null}
      {automationEditor ? (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/35"
          role="presentation"
          onMouseDown={() => setAutomationEditor(null)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label={`Edit ${automationEditor.automation.name}`}
            className="h-full w-full max-w-3xl overflow-y-auto border-l border-border-subtle bg-surface-1 p-6 shadow-[var(--fd-shadow-lg)]"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <AutomationEditor
              key={`${automationEditor.automation.id}:${automationEditor.automation.revision}`}
              state={{
                kind: "edit",
                id: automationEditor.automation.id,
                revision: automationEditor.automation.revision,
                draft: automationDraftFrom(automationEditor.automation),
              }}
              allowElevated={
                automationsByHost[
                  automationEditor.entry.hostId ?? "local"
                ]?.settings?.allow_elevated_automations ?? false
              }
              onCancel={() => setAutomationEditor(null)}
              onSubmit={async (draft, includeTrigger) => {
                const api = hostApi(
                  automationEditor.entry.hostId,
                  localApi,
                  manager,
                );
                if (!api) return;
                const payload = automationDraftArguments(draft);
                if (!includeTrigger) delete payload.trigger;
                const response = await api.controlExecute({
                  operation: "automation.update",
                  arguments: {
                    automation_id: automationEditor.automation.id,
                    ...payload,
                  },
                  expected_revision: automationEditor.automation.revision,
                });
                if (!response.ok) {
                  onToast({
                    variant: "danger",
                    title: "Could not save scheduled task",
                    description: controlErrorMessage(response),
                  });
                  return;
                }
                setAutomationEditor(null);
                await loadAutomations(
                  automationEditor.entry.hostId ?? "local",
                  api,
                );
                onToast({
                  variant: "success",
                  title: "Scheduled task updated",
                });
              }}
            />
          </section>
        </div>
      ) : null}
    </main>
  );
}
