import * as React from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Archive,
  Check,
  ChevronDown,
  Copy,
  FolderPlus,
  LoaderCircle,
  Pin,
  PinOff,
  SquarePen,
} from 'lucide-react'

import type { ProjectGroup, ThreadSummary } from '@falcondeck/client-core'
import {
  Button,
  EmptyState,
  Input,
  Sidebar as SidebarShell,
  SidebarContent,
  SidebarHeader,
  cn,
} from '@falcondeck/ui'

import { ThreadItem, type ThreadItemArchiveHandler } from './thread-item'
import { WorkspaceGroup } from './workspace-group'

const VISIBLE_THREAD_LIMIT = 5
const RELATIVE_TIME_TICK_MS = 60_000
const OPTIMISTIC_SELECTION_TTL_MS = 1_500
const THREAD_MENU_WIDTH_PX = 176
const THREAD_MENU_VIEWPORT_PADDING_PX = 8
const THREAD_MENU_ROW_HEIGHT_PX = 36
const THREAD_MENU_SEPARATOR_HEIGHT_PX = 9

type ThreadContextMenuState = {
  workspaceId: string
  thread: ThreadSummary
  x: number
  y: number
}

async function copyTextToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Clipboard API can be unavailable in older webviews; fall back to execCommand.
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
}

type SidebarEmptyState = {
  title: string
  description?: string
}

export type WorkspaceSidebarProps = {
  groups: ProjectGroup[]
  selectedWorkspaceId: string | null
  selectedThreadId: string | null
  onSelectWorkspace: (workspaceId: string, threadId: string | null) => void
  onSelectThread: (workspaceId: string, threadId: string) => void
  onNewThread?: (workspaceId: string) => void
  onArchiveThread?: ThreadItemArchiveHandler
  onRenameThread?: (workspaceId: string, threadId: string, title: string) => Promise<void> | void
  onTogglePinThread?: (workspaceId: string, threadId: string, pinned: boolean) => Promise<void> | void
  onMarkThreadRead?: (workspaceId: string, threadId: string) => Promise<void> | void
  onAddProject?: () => void
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
  const [expanded, setExpanded] = useState(false)
  const orderedThreads = useMemo(() => {
    const pinned = group.threads.filter((thread) => thread.is_pinned)
    if (pinned.length === 0) return group.threads
    return [...pinned, ...group.threads.filter((thread) => !thread.is_pinned)]
  }, [group.threads])
  const hasOverflow = orderedThreads.length > VISIBLE_THREAD_LIMIT
  const selectedIsHidden =
    hasOverflow &&
    !expanded &&
    selectedThreadId != null &&
    orderedThreads.findIndex((thread) => thread.id === selectedThreadId) >= VISIBLE_THREAD_LIMIT

  const showAll = expanded || selectedIsHidden
  const visible = showAll ? orderedThreads : orderedThreads.slice(0, VISIBLE_THREAD_LIMIT)
  const hiddenCount = orderedThreads.length - VISIBLE_THREAD_LIMIT

  return (
    <>
      {group.threads.length === 0 ? (
        <p className="py-2 pl-2 text-[length:var(--fd-text-xs)] text-fg-muted">No threads yet</p>
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
      {hasOverflow ? (
        <button
          type="button"
          onClick={() => setExpanded(!showAll)}
          className="flex w-full items-center gap-1.5 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-[length:var(--fd-text-xs)] text-fg-muted hover:bg-surface-3 hover:text-fg-secondary"
        >
          <ChevronDown className={cn('h-3 w-3', showAll && 'rotate-180')} />
          {showAll ? 'Show less' : `${hiddenCount} older threads`}
        </button>
      ) : null}
    </>
  )
})

export const WorkspaceSidebar = memo(function WorkspaceSidebar({
  groups,
  selectedWorkspaceId,
  selectedThreadId,
  onSelectWorkspace,
  onSelectThread,
  onNewThread,
  onArchiveThread,
  onRenameThread,
  onTogglePinThread,
  onMarkThreadRead,
  onAddProject,
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
  const threadContextMenuRef = useRef<HTMLDivElement | null>(null)
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
      if (!onArchiveThread && !onRenameThread && !onTogglePinThread && !onMarkThreadRead) return
      setThreadContextMenu(args)
    },
    [onArchiveThread, onMarkThreadRead, onRenameThread, onTogglePinThread],
  )

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

  const workspacePathById = useMemo(
    () => new Map(groups.map((group) => [group.workspace.id, group.workspace.path])),
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

  return (
    <SidebarShell className={className}>
      <SidebarHeader className={headerClassName}>
        <div className="flex items-center justify-between">
          {visualSelectedWorkspaceId && onNewThread ? (
            <button
              type="button"
              onClick={() => handleNewThread(visualSelectedWorkspaceId)}
              className="flex items-center gap-1.5 rounded-[var(--fd-radius-md)] px-1.5 py-1 text-[length:var(--fd-text-sm)] text-fg-secondary hover:bg-surface-3 hover:text-fg-primary"
            >
              <SquarePen className="h-3.5 w-3.5" />
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
            >
              {isAddingProject ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <FolderPlus className="h-4 w-4" />
              )}
            </Button>
          ) : null}
        </div>

        {errors
          .filter(Boolean)
          .map((error) => (
            <p key={error} className="text-[length:var(--fd-text-xs)] text-warning">
              {error}
            </p>
          ))}
      </SidebarHeader>

      <SidebarContent className={contentClassName}>
        <div className="space-y-4">
          {groups.map((group) => (
            <WorkspaceGroup
              key={group.workspace.id}
              workspace={group.workspace}
              isSelected={visualSelectedWorkspaceId === group.workspace.id}
              onSelect={() =>
                handleSelectWorkspace(
                  group.workspace.id,
                  groupMetadata.get(group.workspace.id)?.initialThreadId ?? null,
                )
              }
              onNewThread={onNewThread ? () => handleNewThread(group.workspace.id) : undefined}
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
      </SidebarContent>
      {footer ? <div className="border-t border-border-subtle p-3">{footer}</div> : null}
      <ThreadContextMenu
        menuRef={threadContextMenuRef}
        target={threadContextMenu}
        workspacePath={
          threadContextMenu ? workspacePathById.get(threadContextMenu.workspaceId) ?? null : null
        }
        canRename={Boolean(onRenameThread)}
        canArchive={Boolean(onArchiveThread)}
        canPin={Boolean(onTogglePinThread)}
        canMarkRead={Boolean(onMarkThreadRead)}
        onClose={closeThreadContextMenu}
        onRename={handleStartRenameFromContextMenu}
        onArchive={handleArchiveFromContextMenu}
        onTogglePin={handleTogglePinFromContextMenu}
        onMarkRead={handleMarkReadFromContextMenu}
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
    </SidebarShell>
  )
})

function ThreadMenuItem({
  icon,
  label,
  destructive = false,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  destructive?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex h-9 w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2.5 text-left text-[length:var(--fd-text-sm)]',
        destructive ? 'text-danger hover:bg-danger/10' : 'text-fg-primary hover:bg-surface-3',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

const ThreadContextMenu = memo(
  function ThreadContextMenu({
    target,
    workspacePath,
    canRename,
    canArchive,
    canPin,
    canMarkRead,
    onClose,
    onRename,
    onArchive,
    onTogglePin,
    onMarkRead,
    menuRef,
  }: {
    target: ThreadContextMenuState | null
    workspacePath: string | null
    canRename: boolean
    canArchive: boolean
    canPin: boolean
    canMarkRead: boolean
    onClose: () => void
    onRename: () => void
    onArchive: () => void
    onTogglePin: () => void
    onMarkRead: () => void
    menuRef: React.RefObject<HTMLDivElement | null>
  }) {
    const [copiedField, setCopiedField] = useState<'path' | 'session' | null>(null)

    useEffect(() => {
      setCopiedField(null)
    }, [target])

    if (!target || typeof document === 'undefined') {
      return null
    }

    const showMarkRead = canMarkRead && target.thread.attention.unread
    const sessionId = target.thread.native_session_id
    const iconClassName = 'h-3.5 w-3.5 text-fg-muted'
    const rowCount =
      Number(canPin) +
      Number(canRename) +
      Number(showMarkRead) +
      Number(Boolean(workspacePath)) +
      Number(Boolean(sessionId)) +
      Number(canArchive)

    if (rowCount === 0) {
      return null
    }

    const separatorCount = Number(Boolean(workspacePath) || Boolean(sessionId)) + Number(canArchive)
    const menuHeight =
      THREAD_MENU_VIEWPORT_PADDING_PX * 2 +
      THREAD_MENU_ROW_HEIGHT_PX * rowCount +
      THREAD_MENU_SEPARATOR_HEIGHT_PX * separatorCount
    const left = Math.max(
      THREAD_MENU_VIEWPORT_PADDING_PX,
      Math.min(
        target.x,
        window.innerWidth - THREAD_MENU_WIDTH_PX - THREAD_MENU_VIEWPORT_PADDING_PX,
      ),
    )
    const top = Math.max(
      THREAD_MENU_VIEWPORT_PADDING_PX,
      Math.min(target.y, window.innerHeight - menuHeight - THREAD_MENU_VIEWPORT_PADDING_PX),
    )

    const handleCopy = (field: 'path' | 'session', text: string) => {
      void copyTextToClipboard(text).then(() => {
        setCopiedField(field)
        window.setTimeout(onClose, 600)
      })
    }

    return createPortal(
      <div
        ref={menuRef}
        role="menu"
        aria-label={`Actions for ${target.thread.title || 'thread'}`}
        className="fixed z-50 w-52 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1 shadow-[var(--fd-shadow-lg)]"
        style={{ left, top }}
      >
        {canPin ? (
          <ThreadMenuItem
            icon={
              target.thread.is_pinned ? (
                <PinOff className={iconClassName} />
              ) : (
                <Pin className={iconClassName} />
              )
            }
            label={target.thread.is_pinned ? 'Unpin chat' : 'Pin chat'}
            onClick={onTogglePin}
          />
        ) : null}
        {canRename ? (
          <ThreadMenuItem
            icon={<SquarePen className={iconClassName} />}
            label="Rename"
            onClick={onRename}
          />
        ) : null}
        {showMarkRead ? (
          <ThreadMenuItem
            icon={<Check className={iconClassName} />}
            label="Mark as read"
            onClick={onMarkRead}
          />
        ) : null}
        {workspacePath || sessionId ? (
          <div role="separator" className="mx-2 my-1 border-t border-border-subtle" />
        ) : null}
        {workspacePath ? (
          <ThreadMenuItem
            icon={
              copiedField === 'path' ? (
                <Check className="h-3.5 w-3.5 text-success" />
              ) : (
                <Copy className={iconClassName} />
              )
            }
            label={copiedField === 'path' ? 'Copied' : 'Copy working directory'}
            onClick={() => handleCopy('path', workspacePath)}
          />
        ) : null}
        {sessionId ? (
          <ThreadMenuItem
            icon={
              copiedField === 'session' ? (
                <Check className="h-3.5 w-3.5 text-success" />
              ) : (
                <Copy className={iconClassName} />
              )
            }
            label={copiedField === 'session' ? 'Copied' : 'Copy session ID'}
            onClick={() => handleCopy('session', sessionId)}
          />
        ) : null}
        {canArchive ? (
          <>
            <div role="separator" className="mx-2 my-1 border-t border-border-subtle" />
            <ThreadMenuItem
              icon={<Archive className="h-3.5 w-3.5" />}
              label="Archive"
              destructive
              onClick={() => {
                onArchive()
                onClose()
              }}
            />
          </>
        ) : null}
      </div>,
      document.body,
    )
  },
)

const RenameThreadDialog = memo(function RenameThreadDialog({
  target,
  value,
  error,
  pending,
  onChange,
  onClose,
  onSubmit,
}: {
  target: { workspaceId: string; thread: ThreadSummary } | null
  value: string
  error: string | null
  pending: boolean
  onChange: (value: string) => void
  onClose: () => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}) {
  if (!target || typeof document === 'undefined') {
    return null
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return
        onClose()
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="fd-rename-thread-title"
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 p-5 shadow-[var(--fd-shadow-lg)]"
      >
        <div className="space-y-1">
          <h2 id="fd-rename-thread-title" className="text-[length:var(--fd-text-lg)] font-semibold text-fg-primary">
            Rename thread
          </h2>
          <p className="truncate text-[length:var(--fd-text-sm)] text-fg-muted">
            {target.thread.title || 'New thread'}
          </p>
        </div>

        <div className="mt-4 space-y-2">
          <Input
            aria-label="Thread title"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            disabled={pending}
          />
          {error ? (
            <p className="text-[length:var(--fd-text-xs)] text-danger">{error}</p>
          ) : null}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={!value.trim()} aria-busy={pending}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  )
})
