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

    const hasOverflow = group.threads.length > VISIBLE_THREAD_LIMIT
    const isExpanded = expandedThreadLists.has(group.workspace.id)

    // Auto-expand if the selected thread is beyond the visible limit
    const selectedIsHidden =
      hasOverflow &&
      !isExpanded &&
      selectedThreadId != null &&
      group.threads.findIndex((t) => t.id === selectedThreadId) >= VISIBLE_THREAD_LIMIT

    const showAll = isExpanded || selectedIsHidden
    const visible = hasOverflow && !showAll ? group.threads.slice(0, VISIBLE_THREAD_LIMIT) : group.threads

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
        hiddenCount: group.threads.length - VISIBLE_THREAD_LIMIT,
        isExpanded: showAll,
      })
    }

    return rows
  })
}
