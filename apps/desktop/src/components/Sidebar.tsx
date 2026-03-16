import { useState } from 'react'
import { FolderPlus, LoaderCircle } from 'lucide-react'

import type { ProjectGroup } from '@falcondeck/client-core'
import { WorkspaceGroup, ThreadItem } from '@falcondeck/chat-ui'
import {
  Button,
  EmptyState,
  Input,
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
  onAddProject: (path: string) => Promise<void>
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
  const [workspacePath, setWorkspacePath] = useState('')
  const [showAddProject, setShowAddProject] = useState(false)

  async function handleAdd() {
    if (workspacePath.trim()) {
      await onAddProject(workspacePath.trim())
      setWorkspacePath('')
      setShowAddProject(false)
      return
    }

    if (!window.__TAURI_INTERNALS__) return
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({ directory: true, multiple: false, title: 'Add Project' })
    if (typeof selected === 'string' && selected.trim()) {
      await onAddProject(selected.trim())
      setShowAddProject(false)
    }
  }

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
            <span className="text-[length:var(--fd-text-xs)] font-medium uppercase tracking-[0.12em] text-fg-muted">
              FalconDeck
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setShowAddProject((prev) => !prev)}
          >
            <FolderPlus className="h-4 w-4" />
          </Button>
        </div>

        {showAddProject ? (
          <div className="flex gap-2">
            <Input
              value={workspacePath}
              onChange={(event) => setWorkspacePath(event.target.value)}
              placeholder="/path/to/project"
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleAdd()
              }}
            />
            <Button type="button" size="sm" onClick={() => void handleAdd()} disabled={isAddingProject}>
              {isAddingProject ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : 'Add'}
            </Button>
          </div>
        ) : null}

        {connectionError ? (
          <p className="text-[length:var(--fd-text-xs)] text-danger">{connectionError}</p>
        ) : null}
        {actionError ? (
          <p className="text-[length:var(--fd-text-xs)] text-warning">{actionError}</p>
        ) : null}
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
