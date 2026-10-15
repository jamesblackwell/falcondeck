import type { ProjectFolder, ThreadSummary } from './types'

export const EMPTY_PROJECT_FOLDERS: readonly ProjectFolder[] = []

export function normalizeProjectFolders(value: unknown): ProjectFolder[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  const assigned = new Map<string, Set<string>>()
  return value.flatMap((folder: Partial<ProjectFolder> | null) => {
    if (
      !folder ||
      typeof folder.id !== 'string' ||
      !folder.id.trim() ||
      ids.has(folder.id) ||
      typeof folder.workspace_id !== 'string' ||
      !folder.workspace_id.trim() ||
      typeof folder.name !== 'string' ||
      !folder.name.trim()
    )
      return []
    ids.add(folder.id)
    const members = assigned.get(folder.workspace_id) ?? new Set<string>()
    assigned.set(folder.workspace_id, members)
    const thread_ids = Array.isArray(folder.thread_ids)
      ? folder.thread_ids.filter((id) => {
          if (typeof id !== 'string' || !id || members.has(id)) return false
          members.add(id)
          return true
        })
      : []
    return [
      {
        id: folder.id,
        workspace_id: folder.workspace_id,
        name: folder.name.trim(),
        collapsed: folder.collapsed === true,
        thread_ids,
      },
    ]
  })
}

const workspaceFolders = new WeakMap<
  readonly ProjectFolder[],
  Map<string, readonly ProjectFolder[]>
>()
export function projectFoldersForWorkspace(
  folders: readonly ProjectFolder[],
  workspaceId: string,
): readonly ProjectFolder[] {
  let byWorkspace = workspaceFolders.get(folders)
  if (!byWorkspace) {
    byWorkspace = new Map()
    workspaceFolders.set(folders, byWorkspace)
  }
  let result = byWorkspace.get(workspaceId)
  if (!result) {
    result = folders.filter((folder) => folder.workspace_id === workspaceId)
    byWorkspace.set(workspaceId, result)
  }
  return result
}

const partitions = new WeakMap<
  readonly ThreadSummary[],
  WeakMap<readonly ProjectFolder[], ReturnType<typeof buildPartition>>
>()
/** Cached against immutable snapshot arrays to keep sidebar selection cheap. */
export function partitionProjectFolders(
  threads: readonly ThreadSummary[],
  folders: readonly ProjectFolder[],
) {
  let byFolders = partitions.get(threads)
  if (!byFolders) {
    byFolders = new WeakMap()
    partitions.set(threads, byFolders)
  }
  let result = byFolders.get(folders)
  if (!result) {
    result = buildPartition(threads, folders)
    byFolders.set(folders, result)
  }
  return result
}

/** One pass over tasks; folders preserve their creation order. */
function buildPartition(
  threads: readonly ThreadSummary[],
  folders: readonly ProjectFolder[],
): {
  root: ThreadSummary[]
  folders: { folder: ProjectFolder; threads: ThreadSummary[] }[]
} {
  const buckets = folders.map((folder) => ({
    folder,
    threads: [] as ThreadSummary[],
  }))
  const byThread = new Map<string, ThreadSummary[]>()
  for (const bucket of buckets) {
    for (const id of bucket.folder.thread_ids) {
      if (!byThread.has(id)) byThread.set(id, bucket.threads)
    }
  }
  const root: ThreadSummary[] = []
  for (const thread of threads) (byThread.get(thread.id) ?? root).push(thread)
  return { root, folders: buckets }
}
