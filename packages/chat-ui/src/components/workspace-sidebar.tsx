import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, FolderPlus, LoaderCircle, SquarePen } from 'lucide-react'

import type { ProjectGroup } from '@falcondeck/client-core'
import {
  Button,
  EmptyState,
  Sidebar as SidebarShell,
  SidebarContent,
  SidebarHeader,
  cn,
} from '@falcondeck/ui'

import { ThreadItem } from './thread-item'
import { WorkspaceGroup } from './workspace-group'

const VISIBLE_THREAD_LIMIT = 5
const RELATIVE_TIME_TICK_MS = 60_000
const OPTIMISTIC_SELECTION_TTL_MS = 1_500

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
  onArchiveThread?: (workspaceId: string, threadId: string) => void
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
  nowTick,
}: {
  group: ProjectGroup
  selectedThreadId: string | null
  onSelectThread: (workspaceId: string, threadId: string) => void
  onArchiveThread?: (workspaceId: string, threadId: string) => void
  nowTick: number
}) {
  const [expanded, setExpanded] = useState(false)
  const hasOverflow = group.threads.length > VISIBLE_THREAD_LIMIT
  const selectedIsHidden =
    hasOverflow &&
    !expanded &&
    selectedThreadId != null &&
    group.threads.findIndex((thread) => thread.id === selectedThreadId) >= VISIBLE_THREAD_LIMIT

  const showAll = expanded || selectedIsHidden
  const visible = showAll ? group.threads : group.threads.slice(0, VISIBLE_THREAD_LIMIT)
  const hiddenCount = group.threads.length - VISIBLE_THREAD_LIMIT

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
    </SidebarShell>
  )
})
