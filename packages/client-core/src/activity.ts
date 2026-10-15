import { projectLabel, type ProjectGroup } from './grouping'
import { deriveThreadAttentionPresentation } from './thread-attention'
import type { InteractiveRequest, ThreadSummary } from './types'

export type ActivitySection = 'blocked' | 'failed' | 'ready' | 'running'

export type ActivityEntry = {
  section: ActivitySection
  thread: ThreadSummary
  workspaceId: string
  projectLabel: string
  requests: InteractiveRequest[]
  sortKey: string
}

export type ActivityCounts = {
  blocked: number
  failed: number
  ready: number
}

const SECTION_RANK: Record<ActivitySection, number> = {
  blocked: 0,
  failed: 1,
  ready: 2,
  running: 3,
}

function compareIsoAscending(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareIsoDescending(left: string, right: string) {
  return left < right ? 1 : left > right ? -1 : 0
}

function requestKindRank(request: InteractiveRequest) {
  return request.kind === 'approval' ? 0 : 1
}

function compareRequests(left: InteractiveRequest, right: InteractiveRequest) {
  return (
    compareIsoAscending(left.created_at, right.created_at) ||
    requestKindRank(left) - requestKindRank(right) ||
    left.request_id.localeCompare(right.request_id)
  )
}

function compareEntries(left: ActivityEntry, right: ActivityEntry) {
  const sectionRank = SECTION_RANK[left.section] - SECTION_RANK[right.section]
  if (sectionRank !== 0) return sectionRank

  if (left.section === 'blocked') return left.sortKey.localeCompare(right.sortKey)

  // Failed, ready, and running: the task that just moved comes first.
  return (
    compareIsoDescending(left.thread.updated_at, right.thread.updated_at) ||
    left.thread.id.localeCompare(right.thread.id)
  )
}

function activitySectionForThread(
  thread: ThreadSummary,
  hasInteractiveRequest: boolean,
): ActivitySection | null {
  if (
    hasInteractiveRequest ||
    thread.attention.pending_approval_count + thread.attention.pending_question_count > 0
  ) {
    return 'blocked'
  }

  const attention = deriveThreadAttentionPresentation(thread)
  if (attention.level === 'error' && attention.unread) return 'failed'
  // Before `ready`: a parked turn with background work still running is
  // working, not finished, however unread its last reply is.
  if (attention.level === 'running') return 'running'
  if (thread.status === 'idle' && attention.unread) return 'ready'
  return null
}

/**
 * Build the cross-project Activity queue. A thread belongs to exactly one
 * section, with actionable states taking precedence over informational ones.
 */
export function collectActivityEntries(
  groups: ProjectGroup[],
  interactiveRequests: InteractiveRequest[],
): ActivityEntry[] {
  const requestsByThread = new Map<string, InteractiveRequest[]>()
  for (const request of interactiveRequests) {
    if (!request.thread_id) continue
    const key = `${request.workspace_id}:${request.thread_id}`
    const requests = requestsByThread.get(key) ?? []
    requests.push(request)
    requestsByThread.set(key, requests)
  }
  for (const requests of requestsByThread.values()) requests.sort(compareRequests)

  const entries: ActivityEntry[] = []
  for (const group of groups) {
    for (const thread of group.threads) {
      if (thread.is_archived) continue

      const requests = requestsByThread.get(`${group.workspace.id}:${thread.id}`) ?? []
      const section = activitySectionForThread(thread, requests.length > 0)
      if (!section) continue

      const sortKey =
        section === 'blocked'
          ? `${requests[0]?.kind === 'approval' ? '0' : requests[0] ? '1' : '2'}:${requests[0]?.created_at ?? ''}:${thread.id}`
          : `${thread.updated_at}:${thread.id}`

      entries.push({
        section,
        thread,
        workspaceId: group.workspace.id,
        projectLabel: projectLabel(group.workspace.path),
        requests,
        sortKey,
      })
    }
  }

  return entries.sort(compareEntries)
}

export type RecentEntry = {
  thread: ThreadSummary
  workspaceId: string
  projectLabel: string
}

/** Six hours covers "earlier today" without turning into thread history. */
const RECENT_WINDOW_MS = 6 * 60 * 60 * 1000
const RECENT_LIMIT = 12

/**
 * Threads that finished and left the queue — the trail behind the work.
 *
 * Deliberately the complement of {@link collectActivityEntries}: anything with
 * a section is still live and belongs above, so a thread can never appear in
 * both. Threads that never ran are excluded; an empty thread you opened once
 * is not something you recently completed.
 */
export function collectRecentEntries(
  groups: ProjectGroup[],
  interactiveRequests: InteractiveRequest[],
  options: { nowMs: number; windowMs?: number; limit?: number },
): RecentEntry[] {
  const { nowMs, windowMs = RECENT_WINDOW_MS, limit = RECENT_LIMIT } = options
  const requestThreadKeys = new Set<string>()
  for (const request of interactiveRequests) {
    if (request.thread_id) {
      requestThreadKeys.add(`${request.workspace_id}:${request.thread_id}`)
    }
  }

  const entries: RecentEntry[] = []
  for (const group of groups) {
    for (const thread of group.threads) {
      if (thread.is_archived) continue
      if (thread.attention.last_agent_activity_seq <= 0) continue
      if (
        activitySectionForThread(
          thread,
          requestThreadKeys.has(`${group.workspace.id}:${thread.id}`),
        )
      ) {
        continue
      }

      const age = nowMs - new Date(thread.updated_at).getTime()
      if (!Number.isFinite(age) || age > windowMs) continue

      entries.push({
        thread,
        workspaceId: group.workspace.id,
        projectLabel: projectLabel(group.workspace.path),
      })
    }
  }

  return entries
    .sort(
      (left, right) =>
        compareIsoDescending(left.thread.updated_at, right.thread.updated_at) ||
        left.thread.id.localeCompare(right.thread.id),
    )
    .slice(0, limit)
}

export function countActivityEntries(
  groups: ProjectGroup[],
  interactiveRequests: InteractiveRequest[],
): ActivityCounts {
  const counts: ActivityCounts = { blocked: 0, failed: 0, ready: 0 }
  const requestThreadKeys = new Set<string>()
  for (const request of interactiveRequests) {
    if (request.thread_id) {
      requestThreadKeys.add(`${request.workspace_id}:${request.thread_id}`)
    }
  }

  for (const group of groups) {
    for (const thread of group.threads) {
      if (thread.is_archived) continue
      const section = activitySectionForThread(
        thread,
        requestThreadKeys.has(`${group.workspace.id}:${thread.id}`),
      )
      if (section && section !== 'running') counts[section] += 1
    }
  }
  return counts
}

export type ActivityInboxRow = {
  key: string
  thread: ThreadSummary
  workspaceId: string
  projectLabel: string
  /** Null once the thread has settled: read, idle, nothing pending. */
  section: ActivitySection | null
  /**
   * Whether the row is new to the user: everything in Needs you, and
   * finished turns they have not read. A running task's streaming output
   * does not count until the turn ends.
   */
  unread: boolean
  requests: InteractiveRequest[]
}

export type ActivityInbox = {
  /** Blocked and failed tasks, pinned above the feed until dealt with. */
  needsYou: ActivityInboxRow[]
  /** Everything else with agent activity, newest first. */
  feed: ActivityInboxRow[]
}

/** A week reads as "this week's work" without becoming full history. */
const INBOX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The sidebar Activity inbox: one mail-style list across every project.
 *
 * Unlike {@link collectActivityEntries}, read and running tasks stay in the
 * same chronological feed, so opening a ready task un-bolds its row instead
 * of moving it somewhere else under the pointer.
 */
export function collectActivityInbox(
  groups: ProjectGroup[],
  interactiveRequests: InteractiveRequest[],
  options: { nowMs: number; windowMs?: number },
): ActivityInbox {
  const { nowMs, windowMs = INBOX_WINDOW_MS } = options
  const sectioned = new Map<string, ActivityEntry>()
  for (const entry of collectActivityEntries(groups, interactiveRequests)) {
    sectioned.set(`${entry.workspaceId}:${entry.thread.id}`, entry)
  }

  const needsYou: ActivityInboxRow[] = []
  const feed: ActivityInboxRow[] = []
  for (const entry of sectioned.values()) {
    if (entry.section !== 'blocked' && entry.section !== 'failed') continue
    needsYou.push({
      key: `${entry.workspaceId}:${entry.thread.id}`,
      thread: entry.thread,
      workspaceId: entry.workspaceId,
      projectLabel: entry.projectLabel,
      section: entry.section,
      unread: true,
      requests: entry.requests,
    })
  }

  for (const group of groups) {
    for (const thread of group.threads) {
      if (thread.is_archived) continue
      const key = `${group.workspace.id}:${thread.id}`
      const entry = sectioned.get(key)
      if (entry?.section === 'blocked' || entry?.section === 'failed') continue
      if (!entry && thread.attention.last_agent_activity_seq <= 0) continue
      const age = nowMs - new Date(thread.updated_at).getTime()
      if (!entry && (!Number.isFinite(age) || age > windowMs)) continue

      feed.push({
        key,
        thread,
        workspaceId: group.workspace.id,
        projectLabel: projectLabel(group.workspace.path),
        section: entry?.section ?? null,
        unread: entry?.section === 'ready',
        requests: [],
      })
    }
  }

  feed.sort(
    (left, right) =>
      compareIsoDescending(left.thread.updated_at, right.thread.updated_at) ||
      left.thread.id.localeCompare(right.thread.id),
  )
  return { needsYou, feed }
}
