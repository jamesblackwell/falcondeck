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

/**
 * Lower ranks sort first: chats waiting on the user, then unseen failures,
 * then active runs, then unread. A failure that has been viewed is
 * acknowledged and falls back with the rest (mirrors the attention inbox).
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
      case 'priority':
        return priorityRank(left) - priorityRank(right) || compareByRecency(left, right)
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
): ProjectGroup[] {
  const threadsByWorkspace = new Map<string, ThreadSummary[]>()
  for (const thread of threads) {
    if (thread.is_archived) continue
    const bucket = threadsByWorkspace.get(thread.workspace_id) ?? []
    bucket.push(thread)
    threadsByWorkspace.set(thread.workspace_id, bucket)
  }

  // Paths sort with localeCompare: their order is user-visible in sidebars
  // and this is not a hot path.
  return [...workspaces]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((workspace) => ({
      workspace,
      threads: (threadsByWorkspace.get(workspace.id) ?? []).sort(compareByRecency),
    }))
}

export function projectLabel(path: string) {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

