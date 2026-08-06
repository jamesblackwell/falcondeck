import type { ProjectGroup, ThreadSummary } from '@falcondeck/client-core'

export const VISIBLE_THREAD_LIMIT = 5

export type SidebarRow =
  | {
      key: string
      type: 'workspace'
      workspaceId: string
      workspaceName: string
      isOpen: boolean
      threadCount: number
    }
  | {
      key: string
      type: 'thread'
      workspaceId: string
      thread: ThreadSummary
    }
  | {
      key: string
      type: 'overflow'
      workspaceId: string
      hiddenCount: number
      isExpanded: boolean
    }

export function buildSidebarRows(
  groups: ProjectGroup[],
  collapsedWorkspaces: Set<string>,
  expandedThreadLists: Set<string>,
  selectedThreadId: string | null,
): SidebarRow[] {
  return groups.flatMap((group) => {
    const workspaceName = group.workspace.path.split('/').pop() || group.workspace.path || 'Workspace'
    const isOpen = !collapsedWorkspaces.has(group.workspace.id)

    const workspaceRow: SidebarRow = {
      key: `workspace:${group.workspace.id}`,
      type: 'workspace',
      workspaceId: group.workspace.id,
      workspaceName,
      isOpen,
      threadCount: group.threads.length,
    }

    if (!isOpen) return [workspaceRow]

    const pinned = group.threads.filter((thread) => thread.is_pinned)
    const orderedThreads =
      pinned.length > 0
        ? [...pinned, ...group.threads.filter((thread) => !thread.is_pinned)]
        : group.threads

    const hasOverflow = orderedThreads.length > VISIBLE_THREAD_LIMIT
    const isExpanded = expandedThreadLists.has(group.workspace.id)

    // Auto-expand if the selected thread is beyond the visible limit
    const selectedIsHidden =
      hasOverflow &&
      !isExpanded &&
      selectedThreadId != null &&
      orderedThreads.findIndex((t) => t.id === selectedThreadId) >= VISIBLE_THREAD_LIMIT

    const showAll = isExpanded || selectedIsHidden
    const visible = hasOverflow && !showAll ? orderedThreads.slice(0, VISIBLE_THREAD_LIMIT) : orderedThreads

    const threadRows: SidebarRow[] = visible.map((thread) => ({
      key: `thread:${thread.id}`,
      type: 'thread',
      workspaceId: group.workspace.id,
      thread,
    }))

    const rows: SidebarRow[] = [workspaceRow, ...threadRows]

    if (hasOverflow) {
      rows.push({
        key: `overflow:${group.workspace.id}`,
        type: 'overflow',
        workspaceId: group.workspace.id,
        hiddenCount: orderedThreads.length - VISIBLE_THREAD_LIMIT,
        isExpanded: showAll,
      })
    }

    return rows
  })
}
