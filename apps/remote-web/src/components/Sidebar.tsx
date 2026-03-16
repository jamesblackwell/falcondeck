import { FolderOpen } from 'lucide-react'

import type { ProjectGroup } from '@falcondeck/client-core'
import { ThreadItem, WorkspaceGroup } from '@falcondeck/chat-ui'
import {
  EmptyState,
  Sidebar as SidebarShell,
  SidebarContent,
  SidebarHeader,
} from '@falcondeck/ui'

export type RemoteSidebarProps = {
  groups: ProjectGroup[]
  selectedWorkspaceId: string | null
  selectedThreadId: string | null
  onSelectWorkspace: (workspaceId: string, threadId: string | null) => void
  onSelectThread: (workspaceId: string, threadId: string) => void
  headerContent: React.ReactNode
  error: string | null
}

export function RemoteSidebar({
  groups,
  selectedWorkspaceId,
  selectedThreadId,
  onSelectWorkspace,
  onSelectThread,
  headerContent,
  error,
}: RemoteSidebarProps) {
  return (
    <SidebarShell>
      <SidebarHeader>
        <span className="text-[length:var(--fd-text-xs)] font-medium uppercase tracking-[0.12em] text-fg-muted">
          FalconDeck Remote
        </span>
        {headerContent}
        {error ? <p className="text-[length:var(--fd-text-xs)] text-danger">{error}</p> : null}
      </SidebarHeader>

      <SidebarContent>
        <div className="space-y-3">
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
                <EmptyState title="No threads yet" className="py-4" />
              ) : null}
              {group.threads.map((thread) => (
                <ThreadItem
                  key={thread.id}
                  thread={thread}
                  isSelected={selectedThreadId === thread.id}
                  onSelect={() => onSelectThread(group.workspace.id, thread.id)}
                  compact
                />
              ))}
            </WorkspaceGroup>
          ))}
          {groups.length === 0 ? (
            <EmptyState
              icon={<FolderOpen className="h-5 w-5" />}
              title="Waiting for daemon"
              description="Connect to see projects."
            />
          ) : null}
        </div>
      </SidebarContent>
    </SidebarShell>
  )
}
