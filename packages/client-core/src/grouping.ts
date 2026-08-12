import { deriveThreadAttentionPresentation } from './thread-attention'
import type { ThreadSummary, WorkspaceSummary } from './types'

export type ProjectGroup = {
  workspace: WorkspaceSummary
  threads: ThreadSummary[]
}

/** How the sidebar orders chats inside each project (and the pinned list). */
export type ThreadSortMode = 'priority' | 'last_updated' | 'alphabetical'

export const THREAD_SORT_MODES: readonly ThreadSortMode[] = [
  'priority',
  'last_updated',
  'alphabetical',
]

export function isThreadSortMode(value: unknown): value is ThreadSortMode {
  return THREAD_SORT_MODES.includes(value as ThreadSortMode)
}

// updated_at keeps a plain code-unit comparison — it is uniform ISO-8601, so
// lexicographic order is chronological.
function compareByRecency(left: ThreadSummary, right: ThreadSummary): number {
  return right.updated_at < left.updated_at ? -1 : right.updated_at > left.updated_at ? 1 : 0
}

// Running turns refresh updated_at while streaming, which would make
// neighbouring active rows trade places under the pointer. Titles are
// human-readable and stable for the lifetime of a turn; ids make duplicate or
// untitled chats deterministic.
function compareByStableIdentity(left: ThreadSummary, right: ThreadSummary): number {
  return left.title.localeCompare(right.title) || left.id.localeCompare(right.id)
}

/**
 * Lower ranks sort first within the read/unread buckets: chats waiting on the
 * user, then failures, then active runs, then quiet chats. Unread is handled
 * as the outer bucket by compareThreads so it cannot fall below read activity.
 * A failure that has been viewed is acknowledged and falls back with the rest
 * (mirrors the attention inbox).
 */
function priorityRank(thread: ThreadSummary): number {
  const attention = deriveThreadAttentionPresentation(thread)
  switch (attention.level) {
    case 'awaiting_response':
      return 0
    case 'error':
      return attention.unread ? 1 : 4
    case 'running':
      return 2
    case 'unread':
      return 3
    default:
      return 4
  }
}

export function compareThreads(mode: ThreadSortMode) {
  return (left: ThreadSummary, right: ThreadSummary): number => {
    switch (mode) {
      case 'priority': {
        const leftAttention = deriveThreadAttentionPresentation(left)
        const rightAttention = deriveThreadAttentionPresentation(right)
        const leftRank = priorityRank(left)
        const rightRank = priorityRank(right)
        return (
          Number(!leftAttention.unread) - Number(!rightAttention.unread) ||
          leftRank - rightRank ||
          (leftRank === 2
            ? compareByStableIdentity(left, right)
            : compareByRecency(left, right))
        )
      }
      case 'alphabetical': {
        const leftTitle = left.title.trim()
        const rightTitle = right.title.trim()
        // Untitled threads go last instead of clumping at the top on ''.
        if (!leftTitle || !rightTitle) {
          return Number(!leftTitle) - Number(!rightTitle) || compareByRecency(left, right)
        }
        return leftTitle.localeCompare(rightTitle) || compareByRecency(left, right)
      }
      case 'last_updated':
        return compareByRecency(left, right)
    }
  }
}

export function buildProjectGroups(
  workspaces: WorkspaceSummary[],
  threads: ThreadSummary[],
  workspaceOrder: readonly string[] = [],
): ProjectGroup[] {
  const threadsByWorkspace = new Map<string, ThreadSummary[]>()
  for (const thread of threads) {
    if (thread.is_archived) continue
    const bucket = threadsByWorkspace.get(thread.workspace_id) ?? []
    bucket.push(thread)
    threadsByWorkspace.set(thread.workspace_id, bucket)
  }

  const workspaceRanks = new Map<string, number>()
  workspaceOrder.forEach((workspaceId, index) => {
    if (!workspaceRanks.has(workspaceId)) workspaceRanks.set(workspaceId, index)
  })

  // Paths are the fallback for workspaces that have not been placed yet. This
  // keeps newly connected projects predictable without disturbing saved ones.
  return [...workspaces]
    .sort((left, right) => {
      const leftRank = workspaceRanks.get(left.id)
      const rightRank = workspaceRanks.get(right.id)
      if (leftRank != null || rightRank != null) {
        if (leftRank == null) return 1
        if (rightRank == null) return -1
        if (leftRank !== rightRank) return leftRank - rightRank
      }
      return left.path.localeCompare(right.path)
    })
    .map((workspace) => ({
      workspace,
      threads: (threadsByWorkspace.get(workspace.id) ?? []).sort(compareByRecency),
    }))
}

export function projectLabel(path: string) {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}
