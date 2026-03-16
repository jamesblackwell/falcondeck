import { FolderPlus, LoaderCircle } from 'lucide-react'

import type { ProjectGroup } from '@falcondeck/client-core'
import { WorkspaceGroup, ThreadItem } from '@falcondeck/chat-ui'
import {
  Button,
  EmptyState,
  Sidebar as SidebarShell,
  SidebarContent,
  SidebarHeader,
  StatusIndicator,
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
  onAddProject: () => void
  isAddingProject: boolean
}

function connectionStatusMap(state: ConnectionState) {
  switch (state) {
    case 'ready':
      return 'connected' as const
    case 'error':
      return 'error' as const
    default:
      return 'active' as const
  }
}

export function DesktopSidebar({
  connectionState,
  connectionError,
  actionError,
  groups,
  selectedWorkspaceId,
  selectedThreadId,
  onSelectWorkspace,
  onSelectThread,
  onAddProject,
  isAddingProject,
}: DesktopSidebarProps) {
  return (
    <SidebarShell>
      <SidebarHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <StatusIndicator
              status={connectionStatusMap(connectionState)}
              size="md"
              pulse={connectionState === 'connecting'}
            />
            <span className="text-[length:var(--fd-text-sm)] font-semibold text-fg-primary">
              Threads
            </span>
          </div>
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
