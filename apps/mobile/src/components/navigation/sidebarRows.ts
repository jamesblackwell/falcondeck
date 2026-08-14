import type { ProjectGroup, ThreadSummary } from '@falcondeck/client-core'

export const VISIBLE_THREAD_LIMIT = 5
export const SHOW_MORE_STEP = 10

export type SidebarRow =
  | {
      key: string
      type: 'section'
      title: 'Pinned' | 'Projects'
    }
  | {
      key: string
      type: 'workspace'
      workspaceId: string
      workspaceName: string
      isOpen: boolean
    }
  | {
      key: string
      type: 'thread'
      workspaceId: string
      thread: ThreadSummary
      /**
       * True while the owning project is collapsed. Collapsed rows stay in the
       * data (keys unchanged) so the same cells can animate shut instead of
       * unmounting.
       */
      isCollapsed: boolean
    }
  | {
      key: string
      type: 'overflow'
      workspaceId: string
      hiddenCount: number
      /** The count currently shown — "Show more" advances from here. */
      visibleCount: number
      isExpanded: boolean
      isCollapsed: boolean
    }

export function buildSidebarRows(
  groups: ProjectGroup[],
  collapsedWorkspaces: Set<string>,
  visibleThreadCounts: ReadonlyMap<string, number>,
  selectedThreadId: string | null,
): SidebarRow[] {
  const pinnedRows: SidebarRow[] = groups.flatMap((group) =>
    group.threads
      .filter((thread) => thread.is_pinned)
      .map((thread) => ({
        key: `pinned:${group.workspace.id}:${thread.id}`,
        type: 'thread' as const,
        workspaceId: group.workspace.id,
        thread,
        isCollapsed: false,
      })),
  )

  const projectRows = groups.flatMap((group) => {
    const workspaceName =
      group.workspace.path.split('/').pop() || group.workspace.path || 'Workspace'
    const isOpen = !collapsedWorkspaces.has(group.workspace.id)

    const workspaceRow: SidebarRow = {
      key: `workspace:${group.workspace.id}`,
      type: 'workspace',
      workspaceId: group.workspace.id,
      workspaceName,
      isOpen,
    }

    const unpinnedThreads = group.threads.filter((thread) => !thread.is_pinned)

    const requestedCount = visibleThreadCounts.get(group.workspace.id) ?? VISIBLE_THREAD_LIMIT

    // Reveal just enough to keep the selected thread visible, without jumping
    // straight to the full list.
    const selectedIndex =
      selectedThreadId != null ? unpinnedThreads.findIndex((t) => t.id === selectedThreadId) : -1
    const effectiveCount = selectedIndex >= requestedCount ? selectedIndex + 1 : requestedCount
    const visible = unpinnedThreads.slice(0, effectiveCount)
    const hiddenCount = Math.max(0, unpinnedThreads.length - visible.length)
    const canCollapse = hiddenCount === 0 && unpinnedThreads.length > VISIBLE_THREAD_LIMIT

    const threadRows: SidebarRow[] = visible.map((thread) => ({
      key: `thread:${thread.id}`,
      type: 'thread',
      workspaceId: group.workspace.id,
      thread,
      isCollapsed: !isOpen,
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
        isCollapsed: !isOpen,
      })
    }

    return rows
  })

  return [
    ...(pinnedRows.length > 0
      ? [
          {
            key: 'section:pinned',
            type: 'section' as const,
            title: 'Pinned' as const,
          },
          ...pinnedRows,
        ]
      : []),
    ...(groups.length > 0
      ? [
          {
            key: 'section:projects',
            type: 'section' as const,
            title: 'Projects' as const,
          },
        ]
      : []),
    ...projectRows,
  ]
}
