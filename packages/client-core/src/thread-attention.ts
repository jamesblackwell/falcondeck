import type {
  InteractiveRequest,
  ThreadAttentionLevel,
  ThreadSummary,
} from './types'

export type ThreadAttentionPresentation = {
  level: ThreadAttentionLevel
  badgeLabel: string | null
  unread: boolean
  pendingApprovalCount: number
  pendingQuestionCount: number
  showSpinner: boolean
  showUnreadDot: boolean
  showBadge: boolean
  indicatorTone: 'neutral' | 'info' | 'warning' | 'danger' | 'accent'
}

export function deriveThreadAttentionPresentation(
  thread: ThreadSummary,
  interactiveRequests: InteractiveRequest[] = [],
): ThreadAttentionPresentation {
  const pendingApprovalCount =
    thread.attention.pending_approval_count ||
    interactiveRequests.filter(
      (request) => request.thread_id === thread.id && request.kind === 'approval',
    ).length
  const pendingQuestionCount =
    thread.attention.pending_question_count ||
    interactiveRequests.filter(
      (request) => request.thread_id === thread.id && request.kind === 'question',
    ).length

  const badgeLabel =
    thread.attention.badge_label ??
    (pendingApprovalCount + pendingQuestionCount > 0 ? 'Awaiting response' : null)
  const unread =
    thread.attention.unread ||
    thread.attention.last_agent_activity_seq > thread.attention.last_read_seq

  const level = resolveThreadAttentionLevel(thread, pendingApprovalCount, pendingQuestionCount)

  return {
    level,
    badgeLabel: level === 'awaiting_response' ? badgeLabel : null,
    unread,
    pendingApprovalCount,
    pendingQuestionCount,
    showSpinner: level === 'running',
    showUnreadDot: level === 'unread',
    showBadge: level === 'awaiting_response' && Boolean(badgeLabel),
    indicatorTone:
      level === 'error'
        ? 'danger'
        : level === 'awaiting_response'
          ? 'warning'
          : level === 'unread'
            ? 'info'
            : level === 'running'
              ? 'accent'
              : 'neutral',
  }
}

export function countAwaitingResponseThreads(threads: ThreadSummary[]) {
  return threads.filter((thread) => thread.attention.level === 'awaiting_response').length
}

function resolveThreadAttentionLevel(
  thread: ThreadSummary,
  pendingApprovalCount: number,
  pendingQuestionCount: number,
): ThreadAttentionLevel {
  if (thread.status === 'error' || thread.attention.level === 'error') return 'error'
  if (pendingApprovalCount + pendingQuestionCount > 0) return 'awaiting_response'
  if (thread.status === 'running') return 'running'
  if (thread.attention.unread || thread.attention.last_agent_activity_seq > thread.attention.last_read_seq) return 'unread'
  return 'none'
}
