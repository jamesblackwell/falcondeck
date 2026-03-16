import { FolderPlus, LoaderCircle, SquarePen } from 'lucide-react'

import type { ProjectGroup } from '@falcondeck/client-core'
import { WorkspaceGroup, ThreadItem } from '@falcondeck/chat-ui'
import {
  Button,
  EmptyState,
  Sidebar as SidebarShell,
  SidebarContent,
  SidebarHeader,
} from '@falcondeck/ui'

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
  onAddProject: () => void
  isAddingProject: boolean
}

export function DesktopSidebar({
  connectionError,
  actionError,
  groups,
  selectedWorkspaceId,
  selectedThreadId,
  onSelectWorkspace,
  onSelectThread,
  onNewThread,
  onAddProject,
  isAddingProject,
}: DesktopSidebarProps) {
  return (
    <SidebarShell>
      <SidebarHeader>
        <div className="flex items-center justify-between">
          {selectedWorkspaceId ? (
            <button
              type="button"
              onClick={() => onNewThread(selectedWorkspaceId)}
              className="flex items-center gap-1.5 rounded-[var(--fd-radius-md)] px-1.5 py-1 text-[length:var(--fd-text-sm)] text-fg-secondary transition-colors hover:bg-surface-3 hover:text-fg-primary"
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
              isSelected={selectedWorkspaceId === group.workspace.id}
              onSelect={() =>
                onSelectWorkspace(
                  group.workspace.id,
                  group.workspace.current_thread_id ?? group.threads[0]?.id ?? null,
                )
              }
              onNewThread={() => onNewThread(group.workspace.id)}
            >
              {group.threads.length === 0 ? (
                <p className="py-2 pl-2 text-[length:var(--fd-text-xs)] text-fg-muted">No threads yet</p>
              ) : null}
              {group.threads.map((thread) => (
                <ThreadItem
                  key={thread.id}
                  thread={thread}
                  isSelected={selectedThreadId === thread.id}
                  onSelect={() => onSelectThread(group.workspace.id, thread.id)}
                />
              ))}
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
}
