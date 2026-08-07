import type { ProjectGroup, ThreadSummary } from '@falcondeck/client-core'

export const VISIBLE_THREAD_LIMIT = 5
export const SHOW_MORE_STEP = 10

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
      /** The count currently shown — "Show more" advances from here. */
      visibleCount: number
      isExpanded: boolean
    }

export function buildSidebarRows(
  groups: ProjectGroup[],
  collapsedWorkspaces: Set<string>,
  visibleThreadCounts: ReadonlyMap<string, number>,
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

    const requestedCount = visibleThreadCounts.get(group.workspace.id) ?? VISIBLE_THREAD_LIMIT

    // Reveal just enough to keep the selected thread visible, without jumping
    // straight to the full list.
    const selectedIndex =
      selectedThreadId != null
        ? orderedThreads.findIndex((t) => t.id === selectedThreadId)
        : -1
    const effectiveCount = selectedIndex >= requestedCount ? selectedIndex + 1 : requestedCount
    const visible = orderedThreads.slice(0, effectiveCount)
    const hiddenCount = Math.max(0, orderedThreads.length - visible.length)
    const canCollapse = hiddenCount === 0 && orderedThreads.length > VISIBLE_THREAD_LIMIT

    const threadRows: SidebarRow[] = visible.map((thread) => ({
      key: `thread:${thread.id}`,
      type: 'thread',
      workspaceId: group.workspace.id,
      thread,
    }))

    const rows: SidebarRow[] = [workspaceRow, ...threadRows]

    if (hiddenCount > 0 || canCollapse) {
      rows.push({
        key: `overflow:${group.workspace.id}`,
        type: 'overflow',
        workspaceId: group.workspace.id,
        hiddenCount,
        visibleCount: visible.length,
        isExpanded: canCollapse,
      })
    }

    return rows
  })
}
