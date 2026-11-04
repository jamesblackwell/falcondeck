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
