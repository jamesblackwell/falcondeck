import type { DaemonSnapshot, EventEnvelope, ImageInput } from './types'

export type SnapshotSelection = {
  workspaceId: string | null
  threadId: string | null
}

/**
 * Applies a daemon event to the current snapshot state.
 * Shared by both desktop and remote-web apps.
 */
export function applySnapshotEvent(
  snapshot: DaemonSnapshot | null,
  event: EventEnvelope,
): DaemonSnapshot | null {
  const daemonEvent = event.event
  if (daemonEvent.type === 'snapshot') {
    return daemonEvent.snapshot
  }
  if (!snapshot) return snapshot
  switch (daemonEvent.type) {
    case 'thread-started':
      return {
        ...snapshot,
        workspaces: snapshot.workspaces.map((workspace) =>
          workspace.id === daemonEvent.thread.workspace_id
            ? {
                ...workspace,
                current_thread_id: daemonEvent.thread.id,
                updated_at: daemonEvent.thread.updated_at,
              }
            : workspace,
        ),
        threads: [
          daemonEvent.thread,
          ...snapshot.threads.filter((thread) => thread.id !== daemonEvent.thread.id),
        ],
      }
    case 'thread-updated':
      return {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === daemonEvent.thread.id ? daemonEvent.thread : thread,
        ),
      }
    case 'approval-request':
      return {
        ...snapshot,
        approvals: [daemonEvent.request, ...snapshot.approvals],
      }
    default:
      return snapshot
  }
}

/**
 * Keeps UI selection pinned to a valid restored workspace/thread when ids change
 * across daemon restarts or snapshot rehydration.
 */
export function reconcileSnapshotSelection(
  snapshot: DaemonSnapshot | null,
  selectedWorkspaceId: string | null,
  selectedThreadId: string | null,
): SnapshotSelection {
  if (!snapshot) {
    return { workspaceId: null, threadId: null }
  }

  const workspaceById = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace] as const))
  const threadById = new Map(snapshot.threads.map((thread) => [thread.id, thread] as const))

  let workspaceId = selectedWorkspaceId && workspaceById.has(selectedWorkspaceId) ? selectedWorkspaceId : null
  let threadId = selectedThreadId && threadById.has(selectedThreadId) ? selectedThreadId : null

  if (threadId) {
    workspaceId = threadById.get(threadId)?.workspace_id ?? workspaceId
  }

  if (!workspaceId) {
    workspaceId =
      [...snapshot.workspaces]
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0]?.id ??
      snapshot.threads[0]?.workspace_id ??
      snapshot.workspaces[0]?.id ??
      null
  }

  const workspace = workspaceId ? workspaceById.get(workspaceId) ?? null : null
  const workspaceThreads = workspace
    ? snapshot.threads.filter((thread) => thread.workspace_id === workspace.id)
    : []

  if (!threadId || (workspace && threadById.get(threadId)?.workspace_id !== workspace.id)) {
    const preferredThreadId =
      (workspace?.current_thread_id &&
      threadById.get(workspace.current_thread_id)?.workspace_id === workspace.id
        ? workspace.current_thread_id
        : null) ??
      workspaceThreads[0]?.id ??
      null
    threadId = preferredThreadId
  }

  return { workspaceId, threadId }
}

/**
 * Convert file inputs to ImageInput objects.
 * Shared by both desktop and remote-web apps.
 */
export async function filesToImageInputs(files: FileList | null): Promise<ImageInput[]> {
  if (!files) return []
  const images = Array.from(files).filter((file) => file.type.startsWith('image/'))
  return Promise.all(
    images.map(
      (file) =>
        new Promise<ImageInput>((resolve, reject) => {
          const reader = new FileReader()
          reader.onerror = () => reject(reader.error)
          reader.onload = () =>
            resolve({
              type: 'image',
              id: crypto.randomUUID(),
              name: file.name,
              mime_type: file.type,
              url: String(reader.result),
              local_path: null,
            })
          reader.readAsDataURL(file)
        }),
    ),
  )
}
