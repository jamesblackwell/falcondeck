import {
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

export type AutomationListFilters = {
  query: string;
  status: AutomationStatusFilter;
  host: string;
  project: string;
  activity: AutomationActivityFilter;
  sort: AutomationSort;
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
) {
  const terms = filters.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    if (filters.status !== "all" && entry.task.status !== filters.status) return false;
    if (filters.host !== "all" && (entry.hostId ?? "local") !== filters.host) return false;
    if (filters.project !== "all" && automationProject(entry).key !== filters.project) return false;
    const status = entry.task.last_run?.status;
    if (filters.activity === "attention" && !automationNeedsAttention(entry)) return false;
    if (filters.activity === "failed" && !automationLastRunFailed(entry)) return false;
    if (filters.activity === "waiting" && status !== "awaiting_input") return false;
    if (filters.activity === "running" && status !== "running" && status !== "queued") return false;
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
  }).sort((left, right) => compareEntries(left, right, filters.sort));
}
