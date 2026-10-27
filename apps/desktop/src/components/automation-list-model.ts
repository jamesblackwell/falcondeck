import {
  DUE_NOW_TOLERANCE_MS,
  formatScheduleCadence,
  type Automation,
  type ScheduledTaskSummary,
  type WorkspaceSummary,
} from "@falcondeck/client-core";

export type TaskEntry = {
  hostId: string | null;
  hostName: string;
  online: boolean;
  supported: boolean;
  workspaces: WorkspaceSummary[];
  task: ScheduledTaskSummary;
  automation: Automation | null;
};

export type AutomationStatusFilter = "all" | ScheduledTaskSummary["status"];
export type AutomationActivityFilter = "all" | "attention" | "running" | "failed" | "waiting";
export type AutomationSort = "next" | "name" | "updated" | "last_run";
export type AutomationTimeFilter = "all" | "hour" | "today" | "day" | "week" | "overdue";
export type AutomationGrouping = "time" | "project" | "host" | "none";

export type AutomationListFilters = {
  query: string;
  status: AutomationStatusFilter;
  host: string;
  project: string;
  activity: AutomationActivityFilter;
  time?: AutomationTimeFilter;
  /** Omit when only matching/counting records, to preserve their input order. */
  sort?: AutomationSort;
};

// Request list metadata explicitly: the daemon's default projection omits
// descriptions and update times. Full instructions still load only on demand.
export const AUTOMATION_LIST_FIELDS = [
  "id", "revision", "owner", "name", "description", "state", "trigger",
  "target.provider", "target.workspace_path", "elevated", "required_connectors",
  "concurrency_policy", "misfire_policy", "next_run_at", "last_run_at",
  "latest_outcome", "updated_at",
];

export function taskEntryKey(entry: TaskEntry) {
  return `${entry.hostId ?? "local"}:${entry.task.id}`;
}

export function automationProject(entry: TaskEntry) {
  const workspace = entry.workspaces.find((item) => item.id === entry.task.workspace_id);
  const path = entry.automation?.target.workspace_path ?? workspace?.path ?? null;
  return {
    key: JSON.stringify([entry.hostId, path ?? entry.task.workspace_id]),
    label: path?.split(/[\\/]/).filter(Boolean).at(-1) ?? "Unavailable project",
    path,
    hostId: entry.hostId,
    hostName: entry.hostName,
  };
}

export function automationProjectOptions(entries: TaskEntry[], host: string) {
  const choices = new Map<string, ReturnType<typeof automationProject>>();
  for (const entry of entries) {
    if (host !== "all" && (entry.hostId ?? "local") !== host) continue;
    const project = automationProject(entry);
    choices.set(project.key, project);
  }
  return [...choices.values()].sort((left, right) =>
    left.label.localeCompare(right.label) || left.hostName.localeCompare(right.hostName) ||
    left.key.localeCompare(right.key),
  );
}

export function automationNeedsAttention(entry: TaskEntry) {
  return entry.task.last_run?.status === "awaiting_input" || automationLastRunFailed(entry);
}

export function automationLastRunFailed(entry: TaskEntry) {
  return entry.task.last_run?.status === "failed" || entry.automation?.state === "failed";
}

function timestamp(value: string | null | undefined) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function compareDates(left: number | null, right: number | null, descending = false) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return descending ? right - left : left - right;
}

function executionRank(entry: TaskEntry) {
  const status = entry.task.last_run?.status;
  return status === "running" || status === "queued" || status === "awaiting_input" ? 0 : 1;
}

export function automationIsRunning(entry: TaskEntry) {
  return entry.task.last_run?.status === "running" || entry.task.last_run?.status === "queued";
}

function dayStart(nowMs: number, offset: number) {
  const date = new Date(nowMs);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset).getTime();
}

export function automationMatchesTime(entry: TaskEntry, time: AutomationTimeFilter, nowMs: number) {
  if (time === "all") return true;
  const next = timestamp(entry.task.next_run_at);
  if (entry.task.status !== "active" || next === null) return false;
  if (time === "overdue") return next < nowMs - DUE_NOW_TOLERANCE_MS && executionRank(entry) !== 0;
  if (time === "today") return next >= dayStart(nowMs, 0) && next < dayStart(nowMs, 1);
  const windowMs = time === "hour" ? 3_600_000 : time === "day" ? 86_400_000 : 7 * 86_400_000;
  return next >= nowMs - DUE_NOW_TOLERANCE_MS && next < nowMs + windowMs;
}

export function summarizeAutomationEntries(entries: TaskEntry[], nowMs: number) {
  return entries.reduce((summary, entry) => {
    if (entry.task.status === "active") summary.active += 1;
    if (automationMatchesTime(entry, "day", nowMs)) summary.due += 1;
    if (automationIsRunning(entry)) summary.running += 1;
    if (automationNeedsAttention(entry)) summary.attention += 1;
    return summary;
  }, { active: 0, due: 0, running: 0, attention: 0 });
}

export type AutomationEntryGroup = {
  key: string;
  label: string | null;
  description?: string;
  entries: TaskEntry[];
};

const TIME_GROUPS = {
  progress: "In progress",
  overdue: "Overdue",
  hour: "Next hour",
  today: "Later today",
  tomorrow: "Tomorrow",
  week: "Next 7 days",
  later: "Later",
  unscheduled: "Not scheduled",
  paused: "Paused",
  completed: "Completed",
} as const;
const TIME_GROUP_ORDER = Object.keys(TIME_GROUPS).map((key) => `time:${key}`);

function timeGroup(entry: TaskEntry, nowMs: number): keyof typeof TIME_GROUPS {
  if (executionRank(entry) === 0) return "progress";
  if (entry.task.status === "paused") return "paused";
  if (entry.task.status === "completed") return "completed";
  const next = timestamp(entry.task.next_run_at);
  if (next === null) return "unscheduled";
  if (next < nowMs - DUE_NOW_TOLERANCE_MS) return "overdue";
  if (next < nowMs + 3_600_000) return "hour";
  if (next < dayStart(nowMs, 1)) return "today";
  if (next < dayStart(nowMs, 2)) return "tomorrow";
  if (next < nowMs + 7 * 86_400_000) return "week";
  return "later";
}

export function groupAutomationEntries(entries: TaskEntry[], grouping: AutomationGrouping, nowMs: number) {
  const groups = new Map<string, AutomationEntryGroup>();
  for (const entry of entries) {
    let key = "ungrouped";
    let label: string | null = null;
    let description: string | undefined;
    if (entry.automation?.owner) {
      key = "extensions";
      label = "Used by extensions";
    } else if (grouping === "time") {
      const bucket = timeGroup(entry, nowMs);
      key = `time:${bucket}`;
      label = TIME_GROUPS[bucket];
    } else if (grouping === "project") {
      const project = automationProject(entry);
      key = `project:${project.key}`;
      label = project.label;
      description = `${project.hostName} · ${project.path ?? "Project is no longer connected"}`;
    } else if (grouping === "host") {
      key = `host:${entry.hostId ?? "local"}`;
      label = entry.hostName;
    }
    const group = groups.get(key);
    if (group) group.entries.push(entry);
    else groups.set(key, { key, label, description, entries: [entry] });
  }
  return [...groups.values()].sort((left, right) => {
    const ownerOrder = Number(left.key === "extensions") - Number(right.key === "extensions");
    if (ownerOrder) return ownerOrder;
    if (grouping === "time") return TIME_GROUP_ORDER.indexOf(left.key) - TIME_GROUP_ORDER.indexOf(right.key);
    return (left.label ?? "").localeCompare(right.label ?? "", undefined, { numeric: true, sensitivity: "base" }) ||
      left.key.localeCompare(right.key);
  });
}

function compareEntries(left: TaskEntry, right: TaskEntry, sort: AutomationSort) {
  // Extension-owned records retain their separate section in every sort order.
  const ownerOrder = Number(Boolean(left.automation?.owner)) - Number(Boolean(right.automation?.owner));
  if (ownerOrder) return ownerOrder;
  let order = 0;
  if (sort === "next") {
    order = executionRank(left) - executionRank(right) || compareDates(
      left.task.status === "active" ? timestamp(left.task.next_run_at) : null,
      right.task.status === "active" ? timestamp(right.task.next_run_at) : null,
    );
  } else if (sort === "updated") {
    order = compareDates(timestamp(left.task.updated_at), timestamp(right.task.updated_at), true);
  } else if (sort === "last_run") {
    order = compareDates(
      timestamp(left.automation?.last_run_at ?? left.task.last_run?.completed_at ?? left.task.last_run?.scheduled_for),
      timestamp(right.automation?.last_run_at ?? right.task.last_run?.completed_at ?? right.task.last_run?.scheduled_for),
      true,
    );
  }
  return order || left.task.title.localeCompare(right.task.title, undefined, { numeric: true, sensitivity: "base" }) ||
    taskEntryKey(left).localeCompare(taskEntryKey(right));
}

export function filterAutomationEntries(
  entries: TaskEntry[],
  filters: AutomationListFilters,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
  nowMs = Date.now(),
) {
  const terms = filters.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = entries.filter((entry) => {
    if (filters.status !== "all" && entry.task.status !== filters.status) return false;
    if (filters.host !== "all" && (entry.hostId ?? "local") !== filters.host) return false;
    if (filters.project !== "all" && automationProject(entry).key !== filters.project) return false;
    if (!automationMatchesTime(entry, filters.time ?? "all", nowMs)) return false;
    const status = entry.task.last_run?.status;
    if (filters.activity === "attention" && !automationNeedsAttention(entry)) return false;
    if (filters.activity === "failed" && !automationLastRunFailed(entry)) return false;
    if (filters.activity === "waiting" && status !== "awaiting_input") return false;
    if (filters.activity === "running" && !automationIsRunning(entry)) return false;
    if (!terms.length) return true;
    const cadence = formatScheduleCadence({
      trigger: entry.automation?.trigger,
      resolvedSchedule: entry.automation?.resolved_schedule,
      legacySchedule: entry.automation ? null : entry.task.schedule,
      viewerTimeZone: timeZone,
    });
    const haystack = [entry.task.title, entry.task.prompt_preview, entry.task.provider,
      entry.hostName, automationProject(entry).path, cadence].join(" ").toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  const sort = filters.sort;
  return sort ? matches.sort((left, right) => compareEntries(left, right, sort)) : matches;
}
