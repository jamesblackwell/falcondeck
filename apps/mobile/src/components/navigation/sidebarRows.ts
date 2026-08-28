import {
  compareThreads,
  partitionSidebarThreads,
  type ProjectGroup,
  type ThreadSortMode,
  type ThreadSummary,
} from '@falcondeck/client-core'

export const VISIBLE_THREAD_LIMIT = 5
export const SHOW_MORE_STEP = 10

export type SidebarRow =
  | {
      key: string
      type: 'section'
      title: 'Pinned' | 'Chats' | 'Projects'
      /**
       * Present on Chats when there is at least one row to hide. True while
       * individual chats are visible.
       */
      isOpen?: boolean
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
  sortMode: ThreadSortMode = 'last_updated',
  showChatsSection = false,
  chatsCollapsed = false,
): SidebarRow[] {
  const compare = compareThreads(sortMode)
  const chatGroups = groups.filter((group) => group.workspace.kind === 'casual')
  const projectGroups = groups.filter((group) => group.workspace.kind !== 'casual')
  const pinnedRows: SidebarRow[] = groups
    .flatMap((group) =>
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
    .sort((left, right) => compare(left.thread, right.thread))

  const chatRows: SidebarRow[] = chatGroups
    .flatMap((group) =>
      group.threads
        .filter((thread) => !thread.is_pinned)
        .map((thread) => ({
          key: `chat:${group.workspace.id}:${thread.id}`,
          type: 'thread' as const,
          workspaceId: group.workspace.id,
          thread,
          isCollapsed: chatsCollapsed,
        })),
    )
    .sort((left, right) => {
      if (left.type !== 'thread' || right.type !== 'thread') return 0
      const pinDelta =
        Number(right.thread.is_pinned_in_project) - Number(left.thread.is_pinned_in_project)
      return pinDelta || compare(left.thread, right.thread)
    })

  const projectRows = projectGroups.flatMap((group) => {
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

    const { pinnedInProject, unpinned } = partitionSidebarThreads(group.threads)
    const sortedPinnedInProject = [...pinnedInProject].sort(compare)
    const sortedUnpinned = [...unpinned].sort(compare)

    const requestedCount = visibleThreadCounts.get(group.workspace.id) ?? VISIBLE_THREAD_LIMIT

    // Reveal just enough to keep the selected thread visible, without jumping
    // straight to the full list. Project-pinned chats stay above the window.
    const selectedIndex =
      selectedThreadId != null ? sortedUnpinned.findIndex((t) => t.id === selectedThreadId) : -1
    const effectiveCount = selectedIndex >= requestedCount ? selectedIndex + 1 : requestedCount
    const visibleUnpinned = sortedUnpinned.slice(0, effectiveCount)
    const hiddenCount = Math.max(0, sortedUnpinned.length - visibleUnpinned.length)
    const canCollapse = hiddenCount === 0 && sortedUnpinned.length > VISIBLE_THREAD_LIMIT
    const visible = [...sortedPinnedInProject, ...visibleUnpinned]

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
        visibleCount: visibleUnpinned.length,
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
    ...(projectGroups.length > 0
      ? [
          {
            key: 'section:projects',
            type: 'section' as const,
            title: 'Projects' as const,
          },
        ]
      : []),
    ...projectRows,
    ...(showChatsSection || chatRows.length > 0
      ? [
          {
            key: 'section:chats',
            type: 'section' as const,
            title: 'Chats' as const,
            ...(chatRows.length > 0 ? { isOpen: !chatsCollapsed } : {}),
          },
          ...chatRows,
        ]
      : []),
  ]
}
