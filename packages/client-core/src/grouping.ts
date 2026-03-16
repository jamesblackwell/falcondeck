import type { ThreadSummary, WorkspaceSummary } from './types'

export type ProjectGroup = {
  workspace: WorkspaceSummary
  threads: ThreadSummary[]
}

export function buildProjectGroups(
  workspaces: WorkspaceSummary[],
  threads: ThreadSummary[],
): ProjectGroup[] {
  const threadsByWorkspace = new Map<string, ThreadSummary[]>()
  for (const thread of threads) {
    const bucket = threadsByWorkspace.get(thread.workspace_id) ?? []
    bucket.push(thread)
    threadsByWorkspace.set(thread.workspace_id, bucket)
  }

  return [...workspaces]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((workspace) => ({
      workspace,
      threads: (threadsByWorkspace.get(workspace.id) ?? []).sort((left, right) =>
        right.updated_at.localeCompare(left.updated_at),
      ),
    }))
}

export function projectLabel(path: string) {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

