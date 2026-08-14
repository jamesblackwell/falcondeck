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

  if (left.section === 'blocked' && right.section === 'blocked') {
    return left.sortKey.localeCompare(right.sortKey)
  }

  if (
    (left.section === 'failed' && right.section === 'failed') ||
    (left.section === 'ready' && right.section === 'ready')
  ) {
    return (
      compareIsoDescending(left.thread.updated_at, right.thread.updated_at) ||
      left.thread.id.localeCompare(right.thread.id)
    )
  }

  return left.sortKey.localeCompare(right.sortKey)
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
  if (thread.status === 'idle' && attention.unread) return 'ready'
  if (attention.level === 'running') return 'running'
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
          : section === 'running'
            ? `${thread.title}:${thread.id}`
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
