import { deriveThreadAttentionPresentation } from './thread-attention'
import type { ThreadSummary, WorkspaceSummary } from './types'

export type ProjectGroup = {
  workspace: WorkspaceSummary
  threads: ThreadSummary[]
  /** Put-away chats for this project; omitted from `threads` so the work list stays clean. */
  archivedThreads?: ThreadSummary[]
}

/** How the sidebar orders chats inside each project (and the pinned list). */
export type ThreadSortMode = 'priority' | 'last_updated' | 'alphabetical'

export const THREAD_SORT_MODES: readonly ThreadSortMode[] = [
  'priority',
  'last_updated',
  'alphabetical',
]

export const THREAD_SORT_OPTIONS: {
  mode: ThreadSortMode
  label: string
  description: string
}[] = [
  {
    mode: 'priority',
    label: 'Priority',
    description: 'Replies, unread results, then active work',
  },
  {
    mode: 'last_updated',
    label: 'Last updated',
    description: 'Most recent activity first',
  },
  { mode: 'alphabetical', label: 'Name', description: 'Task titles from A–Z' },
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
 * Lower ranks are the Priority work queue: response needed, unseen failure,
 * newly completed, running, then everything else.
 */
export function threadPriorityRank(thread: ThreadSummary): number {
  const attention = deriveThreadAttentionPresentation(thread)
  switch (attention.level) {
    case 'awaiting_response':
      return 0
    case 'error':
      return attention.unread ? 1 : 4
    case 'unread':
      return thread.status === 'idle' ? 2 : 4
    case 'running':
      return 3
    default:
      return 4
  }
}

export function compareThreads(mode: ThreadSortMode) {
  return (left: ThreadSummary, right: ThreadSummary): number => {
    switch (mode) {
      case 'priority': {
        const leftRank = threadPriorityRank(left)
        const rightRank = threadPriorityRank(right)
        // Recency seeds a Priority view. Stateful consumers retain that order
        // after mount so snapshot churn cannot move rows under the pointer.
        return leftRank - rightRank || compareByRecency(left, right)
      }
      case 'alphabetical': {
        const leftTitle = left.title.trim()
        const rightTitle = right.title.trim()
        // Untitled threads go last instead of clumping at the top on ''.
        if (!leftTitle || !rightTitle) {
          return Number(!leftTitle) - Number(!rightTitle) || left.id.localeCompare(right.id)
        }
        return leftTitle.localeCompare(rightTitle) || left.id.localeCompare(right.id)
      }
      case 'last_updated':
        return compareByRecency(left, right)
    }
  }
}

const EMPTY_ARCHIVED_THREADS: ThreadSummary[] = []

export function archivedThreadsOf(
  group: Pick<ProjectGroup, 'archivedThreads'>,
): ThreadSummary[] {
  return group.archivedThreads ?? EMPTY_ARCHIVED_THREADS
}

export function buildProjectGroups(
  workspaces: WorkspaceSummary[],
  threads: ThreadSummary[],
  workspaceOrder: readonly string[] = [],
  previous?: ProjectGroup[] | null,
): ProjectGroup[] {
  const threadsByWorkspace = new Map<string, ThreadSummary[]>()
  const archivedByWorkspace = new Map<string, ThreadSummary[]>()
  for (const thread of threads) {
    const buckets = thread.is_archived ? archivedByWorkspace : threadsByWorkspace
    const bucket = buckets.get(thread.workspace_id) ?? []
    bucket.push(thread)
    buckets.set(thread.workspace_id, bucket)
  }

  const workspaceRanks = new Map<string, number>()
  workspaceOrder.forEach((workspaceId, index) => {
    if (!workspaceRanks.has(workspaceId)) workspaceRanks.set(workspaceId, index)
  })

  // Paths are the fallback for workspaces that have not been placed yet. This
  // keeps newly connected projects predictable without disturbing saved ones.
  const built = [...workspaces]
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
      archivedThreads: (archivedByWorkspace.get(workspace.id) ?? []).sort(
        compareByRecency,
      ),
    }))

  if (!previous || previous.length === 0) return built

  // Snapshots rebuild every summary object, so without reuse each build hands
  // callers brand-new groups, workspaces, and threads even when nothing
  // changed, invalidating every downstream memo on every event. Compare the
  // fresh build field-by-field against the previous one and keep the old
  // objects wherever content is equal.
  const previousByWorkspaceId = new Map(
    previous.map((group) => [group.workspace.id, group]),
  )
  let allSame = previous.length === built.length
  const reused = built.map((group, index) => {
    const prior = previousByWorkspaceId.get(group.workspace.id)
    if (!prior) {
      allSame = false
      return group
    }
    const workspace = sameSnapshotValue(prior.workspace, group.workspace)
      ? prior.workspace
      : group.workspace
    const threads = reuseThreadsById(prior.threads, group.threads)
    const archivedThreads = reuseThreadsById(
      prior.archivedThreads ?? EMPTY_ARCHIVED_THREADS,
      group.archivedThreads ?? EMPTY_ARCHIVED_THREADS,
    )
    const merged =
      workspace === prior.workspace &&
      threads === prior.threads &&
      archivedThreads === (prior.archivedThreads ?? EMPTY_ARCHIVED_THREADS)
        ? prior
        : { workspace, threads, archivedThreads }
    // Reordering shows up positionally: same groups in a new sequence still
    // produce a new top-level array, which is exactly what consumers keyed on
    // order need to see.
    if (merged !== previous[index]) allSame = false
    return merged
  })

  return allSame ? previous : reused
}

/**
 * Field-wise equality for plain JSON-shaped payloads (summaries, plans,
 * queues). Scalars use strict equality; nested objects and arrays fall back
 * to a structural fingerprint, which stays sound because producers serialize
 * these shapes with stable key order. Covers future fields automatically, so
 * a new summary property can never slip past reuse unnoticed.
 */
function sameSnapshotValue(previous: unknown, next: unknown): boolean {
  if (previous === next) return true
  if (
    typeof previous !== 'object' ||
    typeof next !== 'object' ||
    previous === null ||
    next === null
  ) {
    return false
  }
  return JSON.stringify(previous) === JSON.stringify(next)
}

/** Mirrors reuseById in conversation.ts: match by id, keep the previous
 * object when unchanged, and return the previous array untouched only when
 * every row kept its slot, so reordering still surfaces a new list. */
function reuseThreadsById(
  previous: readonly ThreadSummary[],
  next: readonly ThreadSummary[],
): ThreadSummary[] {
  let previousById: Map<string, ThreadSummary> | null = null
  let allSame = previous.length === next.length
  const reused = next.map((thread, index) => {
    let prior: ThreadSummary | undefined = previous[index]
    if (prior?.id !== thread.id) {
      previousById ??= new Map(
        previous.map((candidate) => [candidate.id, candidate]),
      )
      prior = previousById.get(thread.id)
    }
    const value =
      prior && sameSnapshotValue(prior, thread) ? prior : thread
    if (value !== previous[index]) allSame = false
    return value
  })
  return allSame ? (previous as ThreadSummary[]) : reused
}

/** Splits a project's chats by pin placement. Global pins leave the project. */
export function partitionSidebarThreads(threads: readonly ThreadSummary[]) {
  const globallyPinned: ThreadSummary[] = []
  const pinnedInProject: ThreadSummary[] = []
  const unpinned: ThreadSummary[] = []
  const archived: ThreadSummary[] = []
  for (const thread of threads) {
    if (thread.is_archived) archived.push(thread)
    else if (thread.is_pinned) globallyPinned.push(thread)
    else if (thread.is_pinned_in_project) pinnedInProject.push(thread)
    else unpinned.push(thread)
  }
  return { globallyPinned, pinnedInProject, unpinned, archived }
}

/** Reorders chats inside each project. Pinned rows are sorted separately. */
export function sortProjectGroupThreads(
  groups: readonly ProjectGroup[],
  mode: ThreadSortMode,
): ProjectGroup[] {
  const compare = compareThreads(mode)
  return groups.map((group) => {
    const { globallyPinned, pinnedInProject, unpinned } = partitionSidebarThreads(
      group.threads,
    )
    return {
      ...group,
      threads: [
        ...globallyPinned.sort(compare),
        ...pinnedInProject.sort(compare),
        ...unpinned.sort(compare),
      ],
      archivedThreads: [...archivedThreadsOf(group)].sort(compare),
    }
  })
}

export function projectLabel(path: string) {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}
