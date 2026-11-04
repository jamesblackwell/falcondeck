/** Notification centre: the durable history of attention events and agent
 * notices. Mirrors `falcondeck-core/src/notifications.rs`. */
export type NotificationKind = "input_required" | "review" | "turn_complete" | "error" | "agent_notice";
export type NotificationImportance = "normal" | "high";
export type NotificationFilter = "all" | "needs_you" | "bots";
export type NotificationTarget =
  | { type: "thread"; workspace_id: string; thread_id: string }
  | { type: "review"; review_id: string };

export type NotificationReportRef = {
  report_id: string;
  expires_at: string;
  hosted: boolean;
};

export type NotificationRecord = {
  id: string;
  seq: number;
  kind: NotificationKind;
  title: string;
  preview: string;
  bot?: string;
  thread_id?: string;
  workspace_id?: string;
  created_at: string;
  read_at?: string;
  resolved_at?: string;
  target?: NotificationTarget;
  importance: NotificationImportance;
  has_body: boolean;
  /** Only on a single-record read. */
  body?: string;
  report?: NotificationReportRef;
  repeat_count: number;
};

export type NotificationCounts = {
  unread_count: number;
  needs_you_count: number;
  /** Pass as `up_to_seq` so mark-all cannot swallow a newer record. */
  latest_seq: number;
};

export type NotificationListResponse = NotificationCounts & {
  items: NotificationRecord[];
  next_before_seq?: number;
};

export type NotificationListQuery = {
  filter?: NotificationFilter;
  limit?: number;
  before_seq?: number;
};

export type MarkNotificationsReadRequest = {
  ids?: string[];
  up_to_seq?: number;
};

export const NOTIFICATION_FILTERS: readonly { value: NotificationFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "needs_you", label: "Needs you" },
  { value: "bots", label: "From bots" },
];

/** Still asks something of James. Matches `NotificationRecord::is_waiting`. */
export function notificationIsWaiting(record: NotificationRecord): boolean {
  return (record.kind === "input_required" || record.kind === "review") && !record.resolved_at;
}

export type NotificationAction =
  | { type: "report" }
  | { type: "review"; review_id: string }
  | { type: "thread"; workspace_id: string; thread_id: string }
  | { type: "none" };

/** What opening a record does. A report comes first; its target is the way back. */
export function notificationAction(record: NotificationRecord): NotificationAction {
  if (record.has_body) return { type: "report" };
  const target = record.target;
  if (target?.type === "review") return { type: "review", review_id: target.review_id };
  if (target?.type === "thread") {
    return { type: "thread", workspace_id: target.workspace_id, thread_id: target.thread_id };
  }
  if (record.workspace_id && record.thread_id) {
    return { type: "thread", workspace_id: record.workspace_id, thread_id: record.thread_id };
  }
  return { type: "none" };
}

export type NotificationDay = {
  key: string;
  label: string;
  items: NotificationRecord[];
};

function dayKey(at: Date): string {
  return `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
}

/** Groups a newest-first list by local day, keeping its order. */
export function notificationDays(
  records: readonly NotificationRecord[],
  now: number = Date.now(),
): NotificationDay[] {
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const label = (at: Date) => {
    const key = dayKey(at);
    if (key === dayKey(today)) return "Today";
    if (key === dayKey(yesterday)) return "Yesterday";
    return at.toLocaleDateString(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
      ...(at.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
    });
  };
  const days: NotificationDay[] = [];
  for (const record of records) {
    const at = new Date(record.created_at);
    const key = dayKey(at);
    const last = days[days.length - 1];
    if (last?.key === key) last.items.push(record);
    else days.push({ key, label: label(at), items: [record] });
  }
  return days;
}
