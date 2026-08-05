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
    if (thread.is_archived) continue
    const bucket = threadsByWorkspace.get(thread.workspace_id) ?? []
    bucket.push(thread)
    threadsByWorkspace.set(thread.workspace_id, bucket)
  }

  // Plain code-unit comparisons: paths only need a stable order and
  // updated_at is ISO-8601, so ICU collation is unnecessary on these paths.
  return [...workspaces]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((workspace) => ({
      workspace,
      threads: (threadsByWorkspace.get(workspace.id) ?? []).sort((left, right) =>
        right.updated_at < left.updated_at ? -1 : right.updated_at > left.updated_at ? 1 : 0,
      ),
    }))
}

export function projectLabel(path: string) {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

