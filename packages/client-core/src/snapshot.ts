import type { DaemonSnapshot, EventEnvelope, ImageInput } from './types'

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
