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
  /** Background tasks still running on a thread whose turn has ended. */
  backgroundTaskCount: number
  /** The turn is over but work the agent started is still in flight, and it
   * will wake the thread when that work reports. Distinct from `showSpinner`:
   * nothing is generating output right now. */
  showBackgroundActivity: boolean
  indicatorTone: 'neutral' | 'info' | 'warning' | 'danger' | 'accent'
}

export const SHUTDOWN_INTERRUPTED_TURN_ERROR =
  'FalconDeck was closed while this turn was running'

export function wasTurnInterruptedByShutdown(thread: ThreadSummary) {
  return (
    thread.status === 'error' &&
    thread.last_error === SHUTDOWN_INTERRUPTED_TURN_ERROR
  )
}

export function deriveThreadAttentionPresentation(
  thread: ThreadSummary,
  interactiveRequests: InteractiveRequest[] = [],
): ThreadAttentionPresentation {
  const pendingApprovalCount =
    thread.attention.pending_approval_count ||
    interactiveRequests.filter(
      (request) =>
        request.workspace_id === thread.workspace_id &&
        request.thread_id === thread.id &&
        request.kind === 'approval',
    ).length
  const pendingQuestionCount =
    thread.attention.pending_question_count ||
    interactiveRequests.filter(
      (request) =>
        request.workspace_id === thread.workspace_id &&
        request.thread_id === thread.id &&
        request.kind === 'question',
    ).length

  const badgeLabel =
    thread.attention.badge_label ??
    (pendingApprovalCount + pendingQuestionCount > 0 ? 'Awaiting response' : null)
  const unread =
    thread.attention.unread ||
    thread.attention.last_agent_activity_seq > thread.attention.last_read_seq

  const backgroundTaskCount = thread.attention.background_task_count ?? 0

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
    backgroundTaskCount,
    // A running turn already shows a spinner; the background mark is for the
    // gap the user reads as "finished" when it is not.
    showBackgroundActivity: backgroundTaskCount > 0 && level !== 'running',
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

/** Inline rollup for a collapsed project row: what is live, what is waiting. */
export type ThreadAttentionSummary = {
  /** Threads with a turn in flight. */
  running: number
  /** Threads holding something the user has not seen or answered yet. */
  unread: number
  /** Severity of the unread group, so the row can tint its dot. */
  unreadTone: 'info' | 'warning' | 'danger'
}

export function summarizeThreadAttention(
  threads: readonly ThreadSummary[],
): ThreadAttentionSummary {
  let running = 0
  let unread = 0
  let hasError = false
  let hasAwaiting = false

  for (const thread of threads) {
    const attention = deriveThreadAttentionPresentation(thread)
    if (attention.level === 'running') {
      running += 1
      continue
    }
    // A failure or a finished turn only counts once it is still unseen —
    // read history should leave the collapsed row blank.
    if (attention.level === 'awaiting_response') {
      unread += 1
      hasAwaiting = true
    } else if (
      (attention.level === 'error' || attention.level === 'unread') &&
      attention.unread
    ) {
      unread += 1
      if (attention.level === 'error') hasError = true
    }
  }

  return {
    running,
    unread,
    unreadTone: hasError ? 'danger' : hasAwaiting ? 'warning' : 'info',
  }
}
