import {
  deriveThreadAttentionPresentation,
  summarizeThreadAttention,
  type ThreadAttentionSummary,
} from './thread-attention'
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

export function canBulkArchiveThread(
  thread: Pick<ThreadSummary, 'is_archived' | 'status' | 'queued_turns'>,
): boolean {
  return !thread.is_archived &&
    thread.status !== 'running' &&
    thread.status !== 'waiting_for_input' &&
    thread.queued_turns.length === 0
}

export function buildProjectGroups(
  workspaces: WorkspaceSummary[],
  threads: ThreadSummary[],
  workspaceOrder: readonly string[] = [],
  previous?: ProjectGroup[] | null,
): ProjectGroup[] {
  // A thread id must render once. Merged host snapshots and racing local
  // updates can briefly carry the same id twice, and a repeated React key in
  // the sidebar leaves a ghost row behind. Keep the freshest summary.
  const uniqueThreads = new Map<string, ThreadSummary>()
  for (const thread of threads) {
    const seen = uniqueThreads.get(thread.id)
    if (!seen || Date.parse(thread.updated_at) > Date.parse(seen.updated_at)) {
      uniqueThreads.set(thread.id, thread)
    }
  }

  const threadsByWorkspace = new Map<string, ThreadSummary[]>()
  const archivedByWorkspace = new Map<string, ThreadSummary[]>()
  for (const thread of uniqueThreads.values()) {
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

/**
 * Where a chat sits in the spawn tree the sidebar draws. A chat an agent
 * started is shown under the chat that started it, one rung in, with an elbow
 * connector instead of a line of its own.
 */
export type ThreadNesting = {
  /** 0 for a top-level chat; one rung per spawning ancestor shown above it. */
  depth: number
  /**
   * The rungs whose upright keeps running below this row: bit `k - 1` is set
   * when another row at rung `k` still follows. Rungs above this row's own
   * belong to its ancestors, and their uprights pass straight through it, so
   * a deep spawn never breaks the line back up to its family. Packed into one
   * number rather than an array so sidebar rows stay shallow-comparable.
   */
  trunkMask: number
}

/** One row of a nested list: a chat, or the fold that stands in for the rest. */
export type NestedThreadEntry =
  | ({ kind: 'thread'; thread: ThreadSummary } & ThreadNesting)
  | ({
      kind: 'more'
      /** The chat whose remaining spawns this row reveals. */
      parentId: string
      /** Rows the fold holds back, counting their own spawns. */
      hiddenCount: number
      /** What the held-back rows are doing, so a fold never buries work. */
      hiddenAttention: ThreadAttentionSummary
    } & ThreadNesting)

/** A chat that has spawned others, as the sidebar folds it. */
export type ThreadFamily = {
  /** Every chat descended from this one in the list. */
  descendantCount: number
  /** True while the whole family is folded away under this row. */
  isCollapsed: boolean
  /** What the folded rows are doing; all zero while the family is open. */
  hiddenAttention: ThreadAttentionSummary
}

export type NestedThreadList = {
  entries: readonly NestedThreadEntry[]
  /** Keyed by the parent's id; chats without spawns in the list are absent. */
  families: ReadonlyMap<string, ThreadFamily>
}

export type NestSpawnedThreadsOptions = {
  /** Families the user has folded away. */
  collapsedParentIds?: ReadonlySet<string>
  /** Families the user has opened past the preview limit. */
  expandedParentIds?: ReadonlySet<string>
  /**
   * Spawns shown under a parent before the rest fold into a "more" row.
   * Defaults to {@link NESTED_THREAD_PREVIEW_LIMIT}.
   */
  childPreviewLimit?: number
  /**
   * A chat that must stay on screen, usually the selection: neither a fold
   * nor the preview limit may hide it.
   */
  revealThreadId?: string | null
}

/** Deepest rung the sidebar indents to; deeper spawns share the last one. */
export const MAX_THREAD_NESTING_DEPTH = 3

/** Spawns a family shows before the rest fold into "N more nested threads". */
export const NESTED_THREAD_PREVIEW_LIMIT = 3

const NO_ATTENTION: ThreadAttentionSummary = { running: 0, unread: 0, unreadTone: 'info' }
const EMPTY_FAMILIES: ReadonlyMap<string, ThreadFamily> = new Map()
const EMPTY_IDS: ReadonlySet<string> = new Set()

// Nothing to nest makes the entries independent of every option, so a list
// with no spawns hands back the same array each time it is asked about.
const flatEntriesByList = new WeakMap<readonly ThreadSummary[], readonly NestedThreadEntry[]>()

function flatEntries(threads: readonly ThreadSummary[]): readonly NestedThreadEntry[] {
  let entries = flatEntriesByList.get(threads)
  if (!entries) {
    entries = threads.map((thread) => ({ kind: 'thread' as const, thread, depth: 0, trunkMask: 0 }))
    flatEntriesByList.set(threads, entries)
  }
  return entries
}

/** The chat this one was spawned from, when that chat is in the same list. */
function spawnParentId(
  thread: ThreadSummary,
  byId: ReadonlyMap<string, ThreadSummary>,
): string | null {
  const origin = thread.origin
  if (origin?.kind !== 'agent_spawn') return null
  const parentId = origin.parent_thread_id
  if (parentId === thread.id || !byId.has(parentId)) return null
  return parentId
}

/**
 * Reorders an already-sorted list so agent-spawned chats follow the chat that
 * spawned them, folds families the user has closed, and reports the rung each
 * row sits on.
 *
 * A family keeps the place of its best-placed member rather than its parent's,
 * so the sort mode still decides where it lands: a child that just ran, or that
 * needs an answer, pulls its parent up with it instead of being buried behind
 * an idle one.
 *
 * A spawned chat only nests when its parent is in the same list. In the archive
 * view, in another folder, or past the end of a window, it keeps its own place
 * at the top level rather than vanishing.
 */
export function nestSpawnedThreads(
  threads: readonly ThreadSummary[],
  {
    collapsedParentIds = EMPTY_IDS,
    expandedParentIds = EMPTY_IDS,
    childPreviewLimit = NESTED_THREAD_PREVIEW_LIMIT,
    revealThreadId = null,
  }: NestSpawnedThreadsOptions = {},
): NestedThreadList {
  const byId = new Map<string, ThreadSummary>()
  const rankById = new Map<string, number>()
  threads.forEach((thread, index) => {
    if (byId.has(thread.id)) return
    byId.set(thread.id, thread)
    rankById.set(thread.id, index)
  })

  const parentById = new Map<string, string>()
  const childrenByParent = new Map<string, ThreadSummary[]>()
  for (const thread of threads) {
    const parentId = spawnParentId(thread, byId)
    if (parentId == null || parentById.has(thread.id)) continue
    parentById.set(thread.id, parentId)
    const siblings = childrenByParent.get(parentId)
    if (siblings) siblings.push(thread)
    else childrenByParent.set(parentId, [thread])
  }
  if (childrenByParent.size === 0) {
    return { entries: flatEntries(threads), families: EMPTY_FAMILIES }
  }

  // Best place anything in this chat's family holds in the sorted list.
  const familyRank = new Map<string, number>()
  const rankOfFamily = (thread: ThreadSummary): number => {
    const cached = familyRank.get(thread.id)
    if (cached !== undefined) return cached
    const own = rankById.get(thread.id) ?? threads.length
    // Recorded before recursing, so a chat spawned from its own descendant
    // settles on its own place instead of looping.
    familyRank.set(thread.id, own)
    let best = own
    for (const child of childrenByParent.get(thread.id) ?? []) {
      best = Math.min(best, rankOfFamily(child))
    }
    familyRank.set(thread.id, best)
    return best
  }
  const byFamilyRank = (left: ThreadSummary, right: ThreadSummary) =>
    rankOfFamily(left) - rankOfFamily(right)
  for (const siblings of childrenByParent.values()) siblings.sort(byFamilyRank)

  // Everything below a chat, cycle-safe. Only folded rows ever ask, and each
  // fold asks once, so this stays linear in what it hides.
  const descendantsOf = (thread: ThreadSummary): ThreadSummary[] => {
    const found: ThreadSummary[] = []
    const seen = new Set([thread.id])
    const stack = [...(childrenByParent.get(thread.id) ?? [])]
    while (stack.length > 0) {
      const next = stack.pop() as ThreadSummary
      if (seen.has(next.id)) continue
      seen.add(next.id)
      found.push(next)
      stack.push(...(childrenByParent.get(next.id) ?? []))
    }
    return found
  }
  const descendantCount = new Map<string, number>()
  const countDescendants = (thread: ThreadSummary): number => {
    const cached = descendantCount.get(thread.id)
    if (cached !== undefined) return cached
    descendantCount.set(thread.id, 0)
    let total = 0
    for (const child of childrenByParent.get(thread.id) ?? []) {
      total += 1 + countDescendants(child)
    }
    descendantCount.set(thread.id, total)
    return total
  }

  // The revealed chat and every ancestor above it. A family on this line may
  // not fold the revealed chat away, whatever the user last chose for it.
  const revealLine = new Set<string>()
  for (let id = revealThreadId; id != null && !revealLine.has(id); id = parentById.get(id) ?? null) {
    if (byId.has(id)) revealLine.add(id)
  }
  const holdsReveal = (thread: ThreadSummary) => revealLine.has(thread.id)

  const entries: NestedThreadEntry[] = []
  const families = new Map<string, ThreadFamily>()
  const emitted = new Set<string>()

  const emit = (thread: ThreadSummary, depth: number, trunkMask: number) => {
    if (emitted.has(thread.id)) return
    emitted.add(thread.id)
    entries.push({ kind: 'thread', thread, depth, trunkMask })
    const children = childrenByParent.get(thread.id)
    if (!children) return

    const revealBelow = revealThreadId !== thread.id && holdsReveal(thread)
    const isCollapsed = collapsedParentIds.has(thread.id) && !revealBelow
    families.set(thread.id, {
      descendantCount: countDescendants(thread),
      isCollapsed,
      hiddenAttention: isCollapsed
        ? summarizeThreadAttention(descendantsOf(thread))
        : NO_ATTENTION,
    })
    if (isCollapsed) return

    // The first few spawns, plus any later one the revealed chat sits under.
    const limited = !expandedParentIds.has(thread.id) && children.length > childPreviewLimit
    const shown = limited
      ? children.filter((child, index) => index < childPreviewLimit || holdsReveal(child))
      : children
    const held = limited ? children.filter((child) => !shown.includes(child)) : []

    const childDepth = Math.min(depth + 1, MAX_THREAD_NESTING_DEPTH)
    const ownRung = 1 << (childDepth - 1)
    shown.forEach((child, index) =>
      // Each child inherits the uprights running past this row, and adds its
      // own rung while a sibling, or the fold, is still to come.
      emit(
        child,
        childDepth,
        index === shown.length - 1 && held.length === 0 ? trunkMask : trunkMask | ownRung,
      ),
    )
    if (held.length > 0) {
      const hidden = held.flatMap((child) => [child, ...descendantsOf(child)])
      // Held-back rows still count as placed, so the cycle sweep below does
      // not resurface them at the top level.
      for (const row of hidden) emitted.add(row.id)
      entries.push({
        kind: 'more',
        parentId: thread.id,
        hiddenCount: hidden.length,
        hiddenAttention: summarizeThreadAttention(hidden),
        depth: childDepth,
        trunkMask,
      })
    }
  }

  for (const root of threads
    .filter((thread) => !parentById.has(thread.id))
    .sort(byFamilyRank)) {
    emit(root, 0, 0)
  }
  // Rows inside a folded family were never emitted, so count them as placed
  // before looking for leftovers.
  for (const [parentId, family] of families) {
    if (!family.isCollapsed) continue
    for (const row of descendantsOf(byId.get(parentId) as ThreadSummary)) emitted.add(row.id)
  }
  if (emitted.size < byId.size) {
    // Only a spawn cycle can be left over, since no root reaches it. Show its
    // members at the top level rather than dropping them from the sidebar.
    for (const thread of threads) emit(thread, 0, 0)
  }

  return { entries, families }
}

const EMPTY_THREAD_NESTING: ReadonlyMap<string, ThreadNesting> = new Map()

/**
 * {@link nestSpawnedThreads} as a flat chat order plus per-chat rungs, with no
 * folds or preview limit, for lists that do not render "more" rows yet. Lists
 * with nothing to nest come back by identity so callers keep memoizing.
 */
export function nestSpawnedThreadsFlat(threads: readonly ThreadSummary[]): {
  threads: readonly ThreadSummary[]
  nesting: ReadonlyMap<string, ThreadNesting>
} {
  const { entries, families } = nestSpawnedThreads(threads, {
    childPreviewLimit: Number.POSITIVE_INFINITY,
  })
  if (families.size === 0) return { threads, nesting: EMPTY_THREAD_NESTING }
  const ordered: ThreadSummary[] = []
  const nesting = new Map<string, ThreadNesting>()
  for (const entry of entries) {
    if (entry.kind !== 'thread') continue
    ordered.push(entry.thread)
    nesting.set(entry.thread.id, { depth: entry.depth, trunkMask: entry.trunkMask })
  }
  return { threads: ordered, nesting }
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

/** Projects always shown before recency is consulted. */
export const SIDEBAR_PROJECT_BASE_LIMIT = 5
/** Ceiling on projects shown without "Show more", recent ones included. */
export const SIDEBAR_PROJECT_ACTIVE_LIMIT = 10
/** A project counts as in use when anything in it moved inside this window. */
export const SIDEBAR_PROJECT_RECENT_WINDOW_MS = 36 * 60 * 60 * 1000

/**
 * Latest activity in a project as epoch ms: its newest chat, or the moment it
 * was connected when it has no chats yet. Unparseable stamps count as never.
 */
export function projectLastUsedAt(group: ProjectGroup): number {
  let latest = Date.parse(group.workspace.connected_at ?? '')
  if (Number.isNaN(latest)) latest = -Infinity
  for (const thread of group.threads) {
    const stamp = Date.parse(thread.updated_at)
    if (!Number.isNaN(stamp) && stamp > latest) latest = stamp
  }
  return latest
}

/**
 * Splits the ordered project list into the rows the sidebar shows at rest and
 * the rows folded behind "Show more". The first five always show. Beyond
 * those, projects used inside the recent window fill up to ten slots, most
 * recently used first, so a busy week does not push live work under the
 * fold. Whatever is selected stays visible regardless. Relative order is
 * preserved on both sides so revealing the fold never reshuffles rows.
 */
export function partitionSidebarProjects(
  groups: readonly ProjectGroup[],
  options: { now: number; selectedWorkspaceId?: string | null },
): { visible: ProjectGroup[]; hidden: ProjectGroup[] } {
  const { now, selectedWorkspaceId = null } = options
  if (groups.length <= SIDEBAR_PROJECT_BASE_LIMIT) {
    return { visible: [...groups], hidden: [] }
  }
  const shown = new Set<string>()
  for (const group of groups.slice(0, SIDEBAR_PROJECT_BASE_LIMIT)) {
    shown.add(group.workspace.id)
  }
  const recentBeyondBase = groups
    .slice(SIDEBAR_PROJECT_BASE_LIMIT)
    .map((group) => ({ group, usedAt: projectLastUsedAt(group) }))
    .filter(({ usedAt }) => now - usedAt <= SIDEBAR_PROJECT_RECENT_WINDOW_MS)
    .sort((left, right) => right.usedAt - left.usedAt)
  for (const { group } of recentBeyondBase) {
    if (shown.size >= SIDEBAR_PROJECT_ACTIVE_LIMIT) break
    shown.add(group.workspace.id)
  }
  if (selectedWorkspaceId != null) shown.add(selectedWorkspaceId)

  const visible: ProjectGroup[] = []
  const hidden: ProjectGroup[] = []
  for (const group of groups) {
    if (shown.has(group.workspace.id)) visible.push(group)
    else hidden.push(group)
  }
  return { visible, hidden }
}
