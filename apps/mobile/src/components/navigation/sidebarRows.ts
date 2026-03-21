import type { ProjectGroup, ThreadSummary } from '@falcondeck/client-core'

export type SidebarRow =
  | {
      key: string
      type: 'workspace'
      workspaceId: string
      workspaceName: string
    }
  | {
      key: string
      type: 'thread'
      workspaceId: string
      thread: ThreadSummary
    }

export function buildSidebarRows(groups: ProjectGroup[]): SidebarRow[] {
  return groups.flatMap((group) => {
    const workspaceName = group.workspace.path.split('/').pop() || group.workspace.path || 'Workspace'
    const workspaceRow: SidebarRow = {
      key: `workspace:${group.workspace.id}`,
      type: 'workspace',
      workspaceId: group.workspace.id,
      workspaceName,
    }

    const threadRows: SidebarRow[] = group.threads.map((thread) => ({
      key: `thread:${thread.id}`,
      type: 'thread',
      workspaceId: group.workspace.id,
      thread,
    }))

    return [workspaceRow, ...threadRows]
  })
}
