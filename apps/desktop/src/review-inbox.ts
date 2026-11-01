import {
  REVIEW_DECISION_LABELS,
  itemsAwaitingDecision,
  type NotificationPreferences,
  type Review,
  type ReviewDraft,
  type ReviewEvidence,
} from '@falcondeck/client-core'

/** Compact age: `now`, `5m`, `3h`, `2d`. */
export function reviewAge(createdAt: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 60_000))
  if (!Number.isFinite(minutes) || minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayTimeFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
})

export type GoingAhead = { label: string; passed: boolean }

/**
 * "Going ahead at 17:00 unless you say no." The daemon never acts on it; the
 * agent proceeds by itself, so a time in the past is worth saying plainly.
 */
export function goingAhead(review: Pick<Review, 'going_ahead_at' | 'status'>, now: number = Date.now()): GoingAhead | null {
  if (!review.going_ahead_at) return null
  const at = Date.parse(review.going_ahead_at)
  if (!Number.isFinite(at)) return null
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString()
  const when = (sameDay ? timeFormat : dayTimeFormat).format(at)
  if (review.status !== 'open') return { label: `Was going ahead at ${when}`, passed: true }
  if (at <= now) return { label: `Going ahead since ${when}`, passed: true }
  return { label: `Going ahead at ${when} unless you say no`, passed: false }
}

export type ReviewSections = { open: Review[]; history: Review[] }

/** Open reviews newest first, answered and withdrawn ones by when they closed. */
export function reviewSections(reviews: readonly Review[]): ReviewSections {
  const open: Review[] = []
  const history: Review[] = []
  for (const review of reviews) (review.status === 'open' ? open : history).push(review)
  const closedAt = (review: Review) => Date.parse(review.responded_at ?? review.updated_at)
  open.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  history.sort((a, b) => closedAt(b) - closedAt(a))
  return { open, history }
}

export function openReviewCount(reviews: readonly Review[]): number {
  return reviews.filter((review) => review.status === 'open').length
}

/** The sidebar badge text: a count, capped so it never widens the row. */
export function reviewBadgeLabel(count: number): string | null {
  if (count <= 0) return null
  return count > 99 ? '99+' : String(count)
}

export type SubmitState = {
  ready: boolean
  /** What the submit bar says: what is missing, or what will be sent. */
  message: string
  missing: number
}

/** Whether a draft can be sent, and the sentence the bar shows. */
export function submitState(review: Review, draft: ReviewDraft): SubmitState {
  const missing = itemsAwaitingDecision(review, draft).length
  if (missing > 0) {
    const noun = missing === 1 ? 'item' : 'items'
    return {
      ready: false,
      missing,
      message: `Decide ${missing} more ${noun}, or choose one decision for the whole review.`,
    }
  }
  if (draft.overall?.decision) {
    const undecided = review.items.filter((item) => !draft.items[item.id]?.decision).length
    return {
      ready: true,
      missing: 0,
      message:
        undecided > 0
          ? `${REVIEW_DECISION_LABELS[draft.overall.decision]} covers the ${undecided} undecided ${undecided === 1 ? 'item' : 'items'}.`
          : 'Ready to send.',
    }
  }
  return { ready: true, missing: 0, message: 'Ready to send.' }
}

/** Anything typed that a refetch or a failed send must not throw away. */
export function draftHasContent(draft: ReviewDraft): boolean {
  return (
    Object.values(draft.items).some((entry) => entry.decision || entry.feedback?.trim()) ||
    Boolean(draft.overall?.decision || draft.overall?.note?.trim())
  )
}

export type EvidenceChip = {
  id: string
  label: string
  detail: string | null
  /** Rendered inline as a thumbnail when true. */
  isImage: boolean
  /** The path the daemon reads, if there is one. A URL has none. */
  path: string | null
  url: string | null
}

function fileName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

export function evidenceChip(evidence: ReviewEvidence): EvidenceChip {
  const path = evidence.open_path ?? evidence.original_path
  const label = evidence.title?.trim() || (path ? fileName(path) : evidence.url ?? 'Link')
  const detail = [
    formatBytes(evidence.size_bytes),
    evidence.snapshotted === false && evidence.kind !== 'url' ? 'not frozen' : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return {
    id: evidence.id,
    label,
    detail: detail || null,
    isImage: evidence.kind === 'image' && Boolean(evidence.open_path),
    path: evidence.open_path,
    url: evidence.url,
  }
}

/** `Juno needs a decision: Pricing page`; null when notifications are off. */
export function reviewNotification(
  review: Review,
  preferences: Pick<NotificationPreferences, 'enabled' | 'notify_on_input_required'> | null | undefined,
): { title: string; body: string; key: string } | null {
  // A review is a decision you owe an agent, the same as a question: it follows
  // the "approvals and questions" switch.
  if (preferences && (!preferences.enabled || !preferences.notify_on_input_required)) return null
  const who = review.bot ?? review.created_by.name
  return {
    title: `${who || 'An agent'} needs a decision: ${review.title}`,
    body: review.ask,
    key: `review:${review.id}`,
  }
}

/**
 * Reviews that appeared since the last load. The first load only seeds the set:
 * a backlog at startup is not news. Returns the new ids and the set to keep.
 */
export function newlyOpenReviews(
  seen: ReadonlySet<string> | null,
  reviews: readonly Review[],
): { fresh: Review[]; seen: Set<string> } {
  const open = reviews.filter((review) => review.status === 'open')
  const next = new Set(seen ?? [])
  for (const review of open) next.add(review.id)
  if (seen === null) return { fresh: [], seen: next }
  return { fresh: open.filter((review) => !seen.has(review.id)), seen: next }
}
