import { memo, useCallback, useEffect, useState } from 'react'
import { ChevronDown, FolderPlus, LoaderCircle, SquarePen } from 'lucide-react'

import type { ProjectGroup } from '@falcondeck/client-core'
import { WorkspaceGroup, ThreadItem } from '@falcondeck/chat-ui'
import {
  Button,
  EmptyState,
  Sidebar as SidebarShell,
  SidebarContent,
  SidebarHeader,
} from '@falcondeck/ui'

const VISIBLE_THREAD_LIMIT = 5

type ConnectionState = 'connecting' | 'ready' | 'error'

export type DesktopSidebarProps = {
  connectionState: ConnectionState
  connectionError: string | null
  actionError: string | null
  groups: ProjectGroup[]
  selectedWorkspaceId: string | null
  selectedThreadId: string | null
  onSelectWorkspace: (workspaceId: string, threadId: string | null) => void
  onSelectThread: (workspaceId: string, threadId: string) => void
  onNewThread: (workspaceId: string) => void
  onArchiveThread: (workspaceId: string, threadId: string) => void
  onAddProject: () => void
  isAddingProject: boolean
}

const ThreadList = memo(function ThreadList({
  group,
  selectedThreadId,
  onSelectThread,
  onArchiveThread,
}: {
  group: ProjectGroup
  selectedThreadId: string | null
  onSelectThread: (workspaceId: string, threadId: string) => void
  onArchiveThread: (workspaceId: string, threadId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const hasOverflow = group.threads.length > VISIBLE_THREAD_LIMIT
  const selectedIsHidden =
    hasOverflow &&
    !expanded &&
    selectedThreadId != null &&
    group.threads.findIndex((t) => t.id === selectedThreadId) >= VISIBLE_THREAD_LIMIT

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
          isSelected={selectedThreadId === thread.id}
          onSelect={() => onSelectThread(group.workspace.id, thread.id)}
          onArchive={() => onArchiveThread(group.workspace.id, thread.id)}
        />
      ))}
      {hasOverflow ? (
        <button
          type="button"
          onClick={() => setExpanded(!showAll)}
          className="flex w-full items-center gap-1.5 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-[length:var(--fd-text-xs)] text-fg-muted hover:bg-surface-3 hover:text-fg-secondary"
        >
          <ChevronDown
            className={`h-3 w-3 ${showAll ? 'rotate-180' : ''}`}
          />
          {showAll ? 'Show less' : `${hiddenCount} older threads`}
        </button>
      ) : null}
    </>
  )
})

export const DesktopSidebar = memo(function DesktopSidebar({
  connectionError,
  actionError,
  groups,
  selectedWorkspaceId,
  selectedThreadId,
  onSelectWorkspace,
  onSelectThread,
  onNewThread,
  onArchiveThread,
  onAddProject,
  isAddingProject,
}: DesktopSidebarProps) {
  const [optimisticSelection, setOptimisticSelection] = useState<{
    workspaceId: string | null
    threadId: string | null
  } | null>(null)

  useEffect(() => {
    setOptimisticSelection(null)
  }, [selectedWorkspaceId, selectedThreadId])

  const visualSelectedWorkspaceId = optimisticSelection?.workspaceId ?? selectedWorkspaceId
  const visualSelectedThreadId = optimisticSelection?.threadId ?? selectedThreadId

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
      setOptimisticSelection({ workspaceId, threadId: null })
      onNewThread(workspaceId)
    },
    [onNewThread],
  )

  return (
    <SidebarShell>
      <SidebarHeader>
        <div className="flex items-center justify-between">
          {visualSelectedWorkspaceId ? (
            <button
              type="button"
              onClick={() => handleNewThread(visualSelectedWorkspaceId)}
              className="flex items-center gap-1.5 rounded-[var(--fd-radius-md)] px-1.5 py-1 text-[length:var(--fd-text-sm)] text-fg-secondary hover:bg-surface-3 hover:text-fg-primary"
            >
              <SquarePen className="h-3.5 w-3.5" />
              New thread
            </button>
          ) : (
            <span className="text-[length:var(--fd-text-sm)] text-fg-muted">Threads</span>
          )}
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
        </div>

        {connectionError ? (
          <p className="text-[length:var(--fd-text-xs)] text-danger">{connectionError}</p>
        ) : null}
        {actionError ? (
          <p className="text-[length:var(--fd-text-xs)] text-warning">{actionError}</p>
        ) : null}
      </SidebarHeader>

      <SidebarContent>
        <div className="space-y-4">
          {groups.map((group) => (
            <WorkspaceGroup
              key={group.workspace.id}
              workspace={group.workspace}
              isSelected={visualSelectedWorkspaceId === group.workspace.id}
              onSelect={() =>
                handleSelectWorkspace(
                  group.workspace.id,
                  group.workspace.current_thread_id ?? group.threads[0]?.id ?? null,
                )
              }
              onNewThread={() => handleNewThread(group.workspace.id)}
            >
              <ThreadList
                group={group}
                selectedThreadId={visualSelectedThreadId}
                onSelectThread={handleSelectThread}
                onArchiveThread={onArchiveThread}
              />
            </WorkspaceGroup>
          ))}
          {groups.length === 0 ? (
            <EmptyState
              icon={<FolderPlus className="h-5 w-5" />}
              title="No projects"
              description="Add a project folder to get started."
            />
          ) : null}
        </div>
      </SidebarContent>
    </SidebarShell>
  )
})
