import * as React from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, FolderPlus, LoaderCircle, SquarePen } from 'lucide-react'

import type { ProjectGroup, ThreadSummary } from '@falcondeck/client-core'
import {
  Button,
  EmptyState,
  Sidebar as SidebarShell,
  SidebarContent,
  SidebarHeader,
  cn,
} from '@falcondeck/ui'

import { AttentionInbox } from './attention-inbox'
import {
  DeleteThreadDialog,
  RemoveWorkspaceDialog,
  RenameThreadDialog,
  ThreadContextMenu,
  WorkspaceContextMenu,
  type ThreadContextMenuState,
  type WorkspaceContextMenuState,
} from './sidebar-menus'
import { ThreadItem, type ThreadItemArchiveHandler } from './thread-item'
import { WorkspaceGroup, type WorkspaceHostBadge } from './workspace-group'

const VISIBLE_THREAD_LIMIT = 5
const SHOW_MORE_STEP = 10
const RELATIVE_TIME_TICK_MS = 60_000
const OPTIMISTIC_SELECTION_TTL_MS = 1_500

type SidebarEmptyState = {
  title: string
  description?: string
}

export type WorkspaceSidebarProps = {
  groups: ProjectGroup[]
  // Host badges for workspaces that live on enrolled remote servers,
  // keyed by workspace id.
  workspaceHosts?: Record<string, WorkspaceHostBadge>
  selectedWorkspaceId: string | null
  selectedThreadId: string | null
  onSelectWorkspace: (workspaceId: string, threadId: string | null) => void
  onSelectThread: (workspaceId: string, threadId: string) => void
  onNewThread?: (workspaceId: string) => void
  onArchiveThread?: ThreadItemArchiveHandler
  /** Permanent, unlike archive: also removes a variant thread's checkout. */
  onDeleteThread?: (workspaceId: string, threadId: string) => Promise<void> | void
  onRenameThread?: (workspaceId: string, threadId: string, title: string) => Promise<void> | void
  onTogglePinThread?: (
    workspaceId: string,
    threadId: string,
    pinned: boolean,
  ) => Promise<void> | void
  onMarkThreadRead?: (workspaceId: string, threadId: string) => Promise<void> | void
  onAddProject?: () => void
  onRemoveWorkspace?: (workspaceId: string) => Promise<void> | void
  isAddingProject?: boolean
  title?: string
  errors?: string[]
  emptyState?: SidebarEmptyState
  footer?: React.ReactNode
  className?: string
  headerClassName?: string
  contentClassName?: string
}

const ThreadList = memo(function ThreadList({
  group,
  selectedThreadId,
  onSelectThread,
  onArchiveThread,
  onOpenThreadContextMenu,
  nowTick,
}: {
  group: ProjectGroup
  selectedThreadId: string | null
  onSelectThread: (workspaceId: string, threadId: string) => void
  onArchiveThread?: ThreadItemArchiveHandler
  onOpenThreadContextMenu?: (args: ThreadContextMenuState) => void
  nowTick: number
}) {
  const [visibleCount, setVisibleCount] = useState(VISIBLE_THREAD_LIMIT)
  const unpinnedThreads = useMemo(
    () => group.threads.filter((thread) => !thread.is_pinned),
    [group.threads],
  )

  // Reveal just enough to keep the selected thread visible, without jumping
  // straight to the full list.
  const selectedIndex =
    selectedThreadId != null
      ? unpinnedThreads.findIndex((thread) => thread.id === selectedThreadId)
      : -1
  const effectiveCount = selectedIndex >= visibleCount ? selectedIndex + 1 : visibleCount
  const visible = unpinnedThreads.slice(0, effectiveCount)
  const hiddenCount = Math.max(0, unpinnedThreads.length - visible.length)
  const canCollapse = hiddenCount === 0 && unpinnedThreads.length > VISIBLE_THREAD_LIMIT

  return (
    <>
      {group.threads.length === 0 ? (
        <p className="py-2 pl-2.5 text-[length:var(--fd-text-xs)] text-fg-muted">No threads yet</p>
      ) : null}
      {visible.map((thread) => (
        <ThreadItem
          key={thread.id}
          thread={thread}
          workspaceId={group.workspace.id}
          isSelected={selectedThreadId === thread.id}
          onSelect={onSelectThread}
          onArchive={onArchiveThread}
          onOpenContextMenu={onOpenThreadContextMenu}
          nowTick={nowTick}
        />
      ))}
      {hiddenCount > 0 || canCollapse ? (
        <button
          type="button"
          onClick={() =>
            setVisibleCount(canCollapse ? VISIBLE_THREAD_LIMIT : effectiveCount + SHOW_MORE_STEP)
          }
          aria-expanded={canCollapse}
          className="fd-focus flex w-full items-center gap-1.5 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-[length:var(--fd-text-xs)] text-fg-muted transition-colors duration-[var(--fd-duration-fast)] hover:bg-surface-3 hover:text-fg-secondary"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'h-3 w-3 transition-transform duration-[var(--fd-duration-normal)] ease-[var(--fd-ease-default)]',
              canCollapse && 'rotate-180',
            )}
          />
          {canCollapse ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </>
  )
})

type PinnedThreadEntry = {
  workspaceId: string
  thread: ThreadSummary
}

const PinnedThreadList = memo(function PinnedThreadList({
  entries,
  selectedThreadId,
  onSelectThread,
  onArchiveThread,
  onOpenThreadContextMenu,
  nowTick,
}: {
  entries: PinnedThreadEntry[]
  selectedThreadId: string | null
  onSelectThread: (workspaceId: string, threadId: string) => void
  onArchiveThread?: ThreadItemArchiveHandler
  onOpenThreadContextMenu?: (args: ThreadContextMenuState) => void
  nowTick: number
}) {
  if (entries.length === 0) return null

  return (
    <section aria-labelledby="fd-pinned-threads-heading" className="mb-4">
      <h2
        id="fd-pinned-threads-heading"
        className="px-2.5 pb-1.5 text-[length:var(--fd-text-xs)] font-medium uppercase tracking-[0.08em] text-fg-muted"
      >
        Pinned
      </h2>
      <div>
        {entries.map(({ workspaceId, thread }) => (
          <ThreadItem
            key={`${workspaceId}:${thread.id}`}
            thread={thread}
            workspaceId={workspaceId}
            isSelected={selectedThreadId === thread.id}
            onSelect={onSelectThread}
            onArchive={onArchiveThread}
            onOpenContextMenu={onOpenThreadContextMenu}
            nowTick={nowTick}
          />
        ))}
      </div>
    </section>
  )
})

export const WorkspaceSidebar = memo(function WorkspaceSidebar({
  groups,
  workspaceHosts,
  selectedWorkspaceId,
  selectedThreadId,
  onSelectWorkspace,
  onSelectThread,
  onNewThread,
  onArchiveThread,
  onDeleteThread,
  onRenameThread,
  onTogglePinThread,
  onMarkThreadRead,
  onAddProject,
  onRemoveWorkspace,
  isAddingProject = false,
  title = 'Threads',
  errors = [],
  emptyState = {
    title: 'No projects',
    description: 'Add a project folder to get started.',
  },
  footer,
  className,
  headerClassName,
  contentClassName,
}: WorkspaceSidebarProps) {
  const [optimisticSelection, setOptimisticSelection] = useState<{
    workspaceId: string | null
    threadId: string | null
  } | null>(null)
  const [nowTick, setNowTick] = useState(() => Math.floor(Date.now() / RELATIVE_TIME_TICK_MS))
  const [threadContextMenu, setThreadContextMenu] = useState<ThreadContextMenuState | null>(null)
  const [renameTarget, setRenameTarget] = useState<{
    workspaceId: string
    thread: ThreadSummary
  } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [isRenamingThread, setIsRenamingThread] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{
    workspaceId: string
    thread: ThreadSummary
  } | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [isDeletingThread, setIsDeletingThread] = useState(false)
  const [workspaceContextMenu, setWorkspaceContextMenu] =
    useState<WorkspaceContextMenuState | null>(null)
  const [removeTarget, setRemoveTarget] = useState<{
    workspaceId: string
    path: string
  } | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [isRemovingWorkspace, setIsRemovingWorkspace] = useState(false)
  const threadContextMenuRef = useRef<HTMLDivElement | null>(null)
  const workspaceContextMenuRef = useRef<HTMLDivElement | null>(null)
  const pendingSelection =
    optimisticSelection &&
    (optimisticSelection.workspaceId !== selectedWorkspaceId ||
      optimisticSelection.threadId !== selectedThreadId)
      ? optimisticSelection
      : null

  const visualSelectedWorkspaceId = pendingSelection?.workspaceId ?? selectedWorkspaceId
  const visualSelectedThreadId = pendingSelection?.threadId ?? selectedThreadId

  const groupMetadata = useMemo(
    () =>
      new Map(
        groups.map((group) => [
          group.workspace.id,
          {
            initialThreadId: group.workspace.current_thread_id ?? group.threads[0]?.id ?? null,
            threadIds: new Set(group.threads.map((thread) => thread.id)),
          },
        ]),
      ),
    [groups],
  )

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowTick(Math.floor(Date.now() / RELATIVE_TIME_TICK_MS))
    }, RELATIVE_TIME_TICK_MS)

    return () => {
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    setOptimisticSelection((current) => {
      if (!current) return null
      if (current.workspaceId === selectedWorkspaceId && current.threadId === selectedThreadId) {
        return null
      }

      const metadata = current.workspaceId ? groupMetadata.get(current.workspaceId) : null
      if (!metadata) {
        return null
      }
      if (current.threadId === null) {
        return current
      }
      return metadata.threadIds.has(current.threadId) ? current : null
    })
  }, [groupMetadata, selectedThreadId, selectedWorkspaceId])

  useEffect(() => {
    if (!pendingSelection) return

    const timeout = window.setTimeout(() => {
      setOptimisticSelection((current) => (current === pendingSelection ? null : current))
    }, OPTIMISTIC_SELECTION_TTL_MS)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [pendingSelection])

  const handleSelectWorkspace = useCallback(
    (workspaceId: string, threadId: string | null) => {
      setOptimisticSelection({ workspaceId, threadId })
      onSelectWorkspace(workspaceId, threadId)
    },
    [onSelectWorkspace],
  )

  const handleSelectThread = useCallback(
    (workspaceId: string, threadId: string) => {
      setOptimisticSelection({ workspaceId, threadId })
      onSelectThread(workspaceId, threadId)
    },
    [onSelectThread],
  )

  const handleNewThread = useCallback(
    (workspaceId: string) => {
      if (!onNewThread) return
      setOptimisticSelection({ workspaceId, threadId: null })
      onNewThread(workspaceId)
    },
    [onNewThread],
  )

  const closeThreadContextMenu = useCallback(() => {
    setThreadContextMenu(null)
  }, [])

  const resetRenameDialog = useCallback(() => {
    setRenameTarget(null)
    setRenameValue('')
    setRenameError(null)
  }, [])

  const closeRenameDialog = useCallback(() => {
    if (isRenamingThread) return
    resetRenameDialog()
  }, [isRenamingThread, resetRenameDialog])

  const openRenameDialog = useCallback((workspaceId: string, thread: ThreadSummary) => {
    setThreadContextMenu(null)
    setRenameTarget({ workspaceId, thread })
    setRenameValue(thread.title)
    setRenameError(null)
  }, [])

  const handleOpenThreadContextMenu = useCallback(
    (args: ThreadContextMenuState) => {
      if (
        !onArchiveThread &&
        !onDeleteThread &&
        !onRenameThread &&
        !onTogglePinThread &&
        !onMarkThreadRead
      ) {
        return
      }
      setThreadContextMenu(args)
    },
    [onArchiveThread, onDeleteThread, onMarkThreadRead, onRenameThread, onTogglePinThread],
  )

  const openDeleteDialog = useCallback(() => {
    if (!threadContextMenu || !onDeleteThread) return
    const { workspaceId, thread } = threadContextMenu
    setThreadContextMenu(null)
    setDeleteError(null)
    setDeleteTarget({ workspaceId, thread })
  }, [onDeleteThread, threadContextMenu])

  const closeDeleteDialog = useCallback(() => {
    if (isDeletingThread) return
    setDeleteTarget(null)
    setDeleteError(null)
  }, [isDeletingThread])

  const handleConfirmDeleteThread = useCallback(async () => {
    if (!deleteTarget || !onDeleteThread) return

    setIsDeletingThread(true)
    setDeleteError(null)
    try {
      await onDeleteThread(deleteTarget.workspaceId, deleteTarget.thread.id)
      setDeleteTarget(null)
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Failed to delete thread')
    } finally {
      setIsDeletingThread(false)
    }
  }, [deleteTarget, onDeleteThread])

  const handleArchiveFromContextMenu = useCallback(() => {
    if (!threadContextMenu || !onArchiveThread) return
    const { workspaceId, thread } = threadContextMenu
    setThreadContextMenu(null)
    void Promise.resolve(onArchiveThread(workspaceId, thread.id)).catch(() => {})
  }, [onArchiveThread, threadContextMenu])

  const handleStartRenameFromContextMenu = useCallback(() => {
    if (!threadContextMenu || !onRenameThread) return
    openRenameDialog(threadContextMenu.workspaceId, threadContextMenu.thread)
  }, [onRenameThread, openRenameDialog, threadContextMenu])

  const handleTogglePinFromContextMenu = useCallback(() => {
    if (!threadContextMenu || !onTogglePinThread) return
    const { workspaceId, thread } = threadContextMenu
    setThreadContextMenu(null)
    void Promise.resolve(onTogglePinThread(workspaceId, thread.id, !thread.is_pinned)).catch(
      () => {},
    )
  }, [onTogglePinThread, threadContextMenu])

  const handleMarkReadFromContextMenu = useCallback(() => {
    if (!threadContextMenu || !onMarkThreadRead) return
    const { workspaceId, thread } = threadContextMenu
    setThreadContextMenu(null)
    void Promise.resolve(onMarkThreadRead(workspaceId, thread.id)).catch(() => {})
  }, [onMarkThreadRead, threadContextMenu])

  const handleOpenWorkspaceContextMenu = useCallback(
    (workspaceId: string, path: string, position: { x: number; y: number }) => {
      if (!onRemoveWorkspace) return
      setThreadContextMenu(null)
      setWorkspaceContextMenu({
        workspaceId,
        path,
        x: position.x,
        y: position.y,
      })
    },
    [onRemoveWorkspace],
  )

  const openRemoveDialog = useCallback(() => {
    if (!workspaceContextMenu) return
    const { workspaceId, path } = workspaceContextMenu
    setWorkspaceContextMenu(null)
    setRemoveError(null)
    setRemoveTarget({ workspaceId, path })
  }, [workspaceContextMenu])

  const closeRemoveDialog = useCallback(() => {
    if (isRemovingWorkspace) return
    setRemoveTarget(null)
    setRemoveError(null)
  }, [isRemovingWorkspace])

  const handleConfirmRemoveWorkspace = useCallback(async () => {
    if (!removeTarget || !onRemoveWorkspace) return

    setIsRemovingWorkspace(true)
    setRemoveError(null)
    try {
      await onRemoveWorkspace(removeTarget.workspaceId)
      setRemoveTarget(null)
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : 'Failed to remove project')
    } finally {
      setIsRemovingWorkspace(false)
    }
  }, [onRemoveWorkspace, removeTarget])

  const workspacePathById = useMemo(
    () => new Map(groups.map((group) => [group.workspace.id, group.workspace.path])),
    [groups],
  )
  const pinnedThreads = useMemo(
    () =>
      groups.flatMap((group) =>
        group.threads
          .filter((thread) => thread.is_pinned)
          .map((thread) => ({ workspaceId: group.workspace.id, thread })),
      ),
    [groups],
  )

  const handleRenameSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!renameTarget || !onRenameThread) return

      const nextTitle = renameValue.trim()
      if (!nextTitle) {
        setRenameError('Title cannot be empty')
        return
      }

      setIsRenamingThread(true)
      setRenameError(null)
      try {
        await onRenameThread(renameTarget.workspaceId, renameTarget.thread.id, nextTitle)
        resetRenameDialog()
      } catch (error) {
        setRenameError(error instanceof Error ? error.message : 'Failed to rename thread')
      } finally {
        setIsRenamingThread(false)
      }
    },
    [onRenameThread, renameTarget, renameValue, resetRenameDialog],
  )

  useEffect(() => {
    if (!threadContextMenu) return

    const handlePointerDown = (event: PointerEvent) => {
      if (threadContextMenuRef.current?.contains(event.target as Node)) return
      setThreadContextMenu(null)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setThreadContextMenu(null)
    }

    const handleViewportChange = () => {
      setThreadContextMenu(null)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('scroll', handleViewportChange, true)
    window.addEventListener('resize', handleViewportChange)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('scroll', handleViewportChange, true)
      window.removeEventListener('resize', handleViewportChange)
    }
  }, [threadContextMenu])

  useEffect(() => {
    if (!workspaceContextMenu) return

    const handlePointerDown = (event: PointerEvent) => {
      if (workspaceContextMenuRef.current?.contains(event.target as Node)) return
      setWorkspaceContextMenu(null)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setWorkspaceContextMenu(null)
    }

    const handleViewportChange = () => {
      setWorkspaceContextMenu(null)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('scroll', handleViewportChange, true)
    window.addEventListener('resize', handleViewportChange)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('scroll', handleViewportChange, true)
      window.removeEventListener('resize', handleViewportChange)
    }
  }, [workspaceContextMenu])

  useEffect(() => {
    if (!renameTarget) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isRenamingThread) return
      resetRenameDialog()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isRenamingThread, renameTarget, resetRenameDialog])

  useEffect(() => {
    if (!deleteTarget) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isDeletingThread) return
      setDeleteTarget(null)
      setDeleteError(null)
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [deleteTarget, isDeletingThread])

  useEffect(() => {
    if (!removeTarget) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isRemovingWorkspace) return
      setRemoveTarget(null)
      setRemoveError(null)
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isRemovingWorkspace, removeTarget])

  return (
    <SidebarShell className={className}>
      <SidebarHeader className={headerClassName}>
        <div className="flex items-center justify-between">
          {visualSelectedWorkspaceId && onNewThread ? (
            <button
              type="button"
              onClick={() => handleNewThread(visualSelectedWorkspaceId)}
              className="fd-focus flex items-center gap-1.5 rounded-[var(--fd-radius-md)] px-1.5 py-1 text-[length:var(--fd-text-sm)] text-fg-secondary hover:bg-surface-3 hover:text-fg-primary"
            >
              <SquarePen aria-hidden="true" className="h-3.5 w-3.5" />
              New thread
            </button>
          ) : (
            <span className="text-[length:var(--fd-text-sm)] text-fg-muted">{title}</span>
          )}
          {onAddProject ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onAddProject}
              disabled={isAddingProject}
              title="Add project"
              aria-label="Add project"
              aria-busy={isAddingProject}
            >
              {isAddingProject ? (
                <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
              ) : (
                <FolderPlus aria-hidden="true" className="h-4 w-4" />
              )}
            </Button>
          ) : null}
        </div>

        {errors.filter(Boolean).map((error) => (
          <p key={error} className="text-[length:var(--fd-text-xs)] text-warning">
            {error}
          </p>
        ))}
      </SidebarHeader>

      <SidebarContent className={contentClassName}>
        <PinnedThreadList
          entries={pinnedThreads}
          selectedThreadId={visualSelectedThreadId}
          onSelectThread={handleSelectThread}
          onArchiveThread={onArchiveThread}
          onOpenThreadContextMenu={handleOpenThreadContextMenu}
          nowTick={nowTick}
        />
        <AttentionInbox
          groups={groups}
          selectedThreadId={visualSelectedThreadId}
          onSelectThread={handleSelectThread}
        />
        <section aria-labelledby="fd-projects-heading">
          <h2
            id="fd-projects-heading"
            className="px-2.5 pb-1.5 text-[length:var(--fd-text-xs)] font-medium uppercase tracking-[0.08em] text-fg-muted"
          >
            Projects
          </h2>
          <div className="space-y-4">
            {groups.map((group) => (
              <WorkspaceGroup
                key={group.workspace.id}
                workspace={group.workspace}
                host={workspaceHosts?.[group.workspace.id] ?? null}
                isSelected={visualSelectedWorkspaceId === group.workspace.id}
                onSelect={() =>
                  handleSelectWorkspace(
                    group.workspace.id,
                    groupMetadata.get(group.workspace.id)?.initialThreadId ?? null,
                  )
                }
                onNewThread={onNewThread ? () => handleNewThread(group.workspace.id) : undefined}
                onOpenContextMenu={
                  onRemoveWorkspace
                    ? (position) =>
                        handleOpenWorkspaceContextMenu(
                          group.workspace.id,
                          group.workspace.path,
                          position,
                        )
                    : undefined
                }
              >
                <ThreadList
                  group={group}
                  selectedThreadId={visualSelectedThreadId}
                  onSelectThread={handleSelectThread}
                  onArchiveThread={onArchiveThread}
                  onOpenThreadContextMenu={handleOpenThreadContextMenu}
                  nowTick={nowTick}
                />
              </WorkspaceGroup>
            ))}
            {groups.length === 0 ? (
              <EmptyState
                icon={onAddProject ? <FolderPlus className="h-5 w-5" /> : undefined}
                title={emptyState.title}
                description={emptyState.description}
              />
            ) : null}
          </div>
        </section>
      </SidebarContent>
      {footer ? <div className="border-t border-border-subtle p-3">{footer}</div> : null}
      <ThreadContextMenu
        menuRef={threadContextMenuRef}
        target={threadContextMenu}
        workspacePath={
          threadContextMenu ? (workspacePathById.get(threadContextMenu.workspaceId) ?? null) : null
        }
        canRename={Boolean(onRenameThread)}
        canArchive={Boolean(onArchiveThread)}
        canDelete={Boolean(onDeleteThread)}
        canPin={Boolean(onTogglePinThread)}
        canMarkRead={Boolean(onMarkThreadRead)}
        onClose={closeThreadContextMenu}
        onRename={handleStartRenameFromContextMenu}
        onArchive={handleArchiveFromContextMenu}
        onDelete={openDeleteDialog}
        onTogglePin={handleTogglePinFromContextMenu}
        onMarkRead={handleMarkReadFromContextMenu}
      />
      <DeleteThreadDialog
        target={deleteTarget}
        error={deleteError}
        pending={isDeletingThread}
        onClose={closeDeleteDialog}
        onConfirm={handleConfirmDeleteThread}
      />
      <RenameThreadDialog
        target={renameTarget}
        value={renameValue}
        error={renameError}
        pending={isRenamingThread}
        onChange={setRenameValue}
        onClose={closeRenameDialog}
        onSubmit={handleRenameSubmit}
      />
      <WorkspaceContextMenu
        menuRef={workspaceContextMenuRef}
        target={workspaceContextMenu}
        onRemove={openRemoveDialog}
      />
      <RemoveWorkspaceDialog
        target={removeTarget}
        error={removeError}
        pending={isRemovingWorkspace}
        onClose={closeRemoveDialog}
        onConfirm={handleConfirmRemoveWorkspace}
      />
    </SidebarShell>
  )
})
