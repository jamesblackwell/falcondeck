/** Review inbox: decisions an agent needs from James, with the evidence to make
 * them. Mirrors `falcondeck-core/src/reviews.rs`. */
import type { ControlRequestContext } from "./control";

export const REVIEW_STATUSES = ["open", "approved", "changes_requested", "rejected", "withdrawn"] as const;
export type ReviewStatus = typeof REVIEW_STATUSES[number];
export const REVIEW_DECISIONS = ["approve", "request_changes", "reject"] as const;
export type ReviewDecision = typeof REVIEW_DECISIONS[number];
export type ReviewEvidenceKind = "file" | "image" | "url";

export type ReviewEvidence = {
  id: string;
  kind: ReviewEvidenceKind;
  title: string | null;
  caption: string | null;
  /** Absolute path to open with `file.stat`/`file.read_range`: the frozen copy when `snapshotted`. */
  open_path: string | null;
  original_path: string | null;
  snapshotted: boolean;
  url: string | null;
  content_type: string | null;
  size_bytes: number | null;
};
export type ReviewItem = {
  id: string;
  title: string;
  note: string;
  evidence: ReviewEvidence[];
  decision: ReviewDecision | null;
  feedback: string | null;
};
export type ReviewActor = { name: string; context: ControlRequestContext };
export type ReviewDelivery =
  | { state: "delivered"; at: string }
  | { state: "failed"; at: string; error: string };
export type Review = {
  id: string;
  title: string;
  /** The one-line question. */
  ask: string;
  recommendation: string;
  /** The agent proceeds then unless James says no (RFC 3339). */
  going_ahead_at: string | null;
  /** Markdown context above the items. */
  body: string;
  status: ReviewStatus;
  items: ReviewItem[];
  source_thread_id: string | null;
  source_workspace_id: string | null;
  bot: string | null;
  created_by: ReviewActor;
  created_at: string;
  updated_at: string;
  folder: string | null;
  responded_at: string | null;
  overall_decision: ReviewDecision | null;
  overall_note: string | null;
  delivery: ReviewDelivery | null;
};
export type ReviewFilters = { status?: ReviewStatus; bot?: string; include_closed?: boolean };

export type ReviewItemResponse = { item_id: string; decision: ReviewDecision; feedback?: string };
/** Per-item decisions, or one overall `decision` (+ `note`) for items without their own. */
export type RespondReviewArgs = {
  review_id: string;
  items?: ReviewItemResponse[];
  decision?: ReviewDecision;
  note?: string;
};

export const REVIEW_DECISION_LABELS: Record<ReviewDecision, string> = {
  approve: "Approve",
  request_changes: "Request changes",
  reject: "Reject",
};
export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  open: "Open",
  approved: "Approved",
  changes_requested: "Changes requested",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

/** Open reviews, newest first, for the sidebar badge and inbox list. */
export function openReviews(reviews: readonly Review[]): Review[] {
  return reviews
    .filter((review) => review.status === "open")
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

/** What James has typed so far, per item, plus the whole-review fallback. */
export type ReviewDraft = {
  items: Record<string, { decision?: ReviewDecision; feedback?: string }>;
  overall?: { decision?: ReviewDecision; note?: string };
};

/** Items still missing a decision (neither their own nor an overall one). */
export function itemsAwaitingDecision(review: Review, draft: ReviewDraft): ReviewItem[] {
  if (draft.overall?.decision) return [];
  return review.items.filter((item) => !draft.items[item.id]?.decision);
}

/** Build the `review.respond` arguments from a draft; null until every item is decided. */
export function buildRespondArgs(review: Review, draft: ReviewDraft): RespondReviewArgs | null {
  if (itemsAwaitingDecision(review, draft).length > 0) return null;
  const items: ReviewItemResponse[] = [];
  for (const item of review.items) {
    const entry = draft.items[item.id];
    if (!entry?.decision) continue;
    const feedback = entry.feedback?.trim();
    items.push({ item_id: item.id, decision: entry.decision, ...(feedback ? { feedback } : {}) });
  }
  const note = draft.overall?.note?.trim();
  return {
    review_id: review.id,
    ...(items.length > 0 ? { items } : {}),
    ...(draft.overall?.decision ? { decision: draft.overall.decision } : {}),
    ...(note ? { note } : {}),
  };
}

/** One line summarising what James decided, for list rows. */
export function reviewOutcomeSummary(review: Review): string {
  if (review.status === "open") return "Waiting on you";
  const counts = new Map<ReviewDecision, number>();
  for (const item of review.items) {
    if (item.decision) counts.set(item.decision, (counts.get(item.decision) ?? 0) + 1);
  }
  const parts = REVIEW_DECISIONS.filter((decision) => counts.has(decision)).map(
    (decision) => `${counts.get(decision)} ${REVIEW_DECISION_LABELS[decision].toLowerCase()}`,
  );
  return parts.length > 0 ? parts.join(", ") : REVIEW_STATUS_LABELS[review.status];
}

/** Whether the daemon supports the review inbox and the setting is on. Older daemons omit the flag. */
export function reviewInboxEnabled(preferences: { review_inbox_enabled?: boolean } | null | undefined): boolean {
  return preferences?.review_inbox_enabled === true;
}

export function isReviewDelivered(review: Review): boolean | null {
  if (!review.delivery) return null;
  return review.delivery.state === "delivered";
}
