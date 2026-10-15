import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FolderClosed, FolderOpen } from 'lucide-react'
import type {
  ProjectFolder,
  ProjectFolderMutation,
} from '@falcondeck/client-core'
import { Button, Input } from '@falcondeck/ui'

export type FolderTaskTarget = { workspaceId: string; threadId: string }
export type FolderEditorTarget = { workspaceId: string; folder?: ProjectFolder }
type DraggedTask = FolderTaskTarget
type Editor = FolderEditorTarget

function FolderDialog({
  title,
  children,
  onClose,
}: {
  title: string
  children: React.ReactNode
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const frame = ref.current
    frame?.querySelector<HTMLElement>('input, button')?.focus()
    return () => {
      previous?.focus({ preventScroll: true })
    }
  }, [])
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--fd-overlay)] p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 p-5 shadow-[var(--fd-shadow-lg)]"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
          if (event.key !== 'Tab') return
          const items = Array.from(
            ref.current?.querySelectorAll<HTMLElement>(
              'input:not(:disabled), button:not(:disabled)',
            ) ?? [],
          )
          const edge = event.shiftKey ? items[0] : items.at(-1)
          if (document.activeElement === edge) {
            event.preventDefault()
            ;(event.shiftKey ? items.at(-1) : items[0])?.focus()
          }
        }}
      >
        <h2 className="mb-4 text-lg font-semibold text-fg-primary">{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  )
}

export function FolderEditor({
  editor,
  onSave,
  onClose,
}: {
  editor: Editor
  onSave: (mutation: ProjectFolderMutation) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(editor.folder?.name ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => {
    if (!pending) onClose()
  }
  return (
    <FolderDialog
      title={editor.folder ? 'Rename folder' : 'Create folder'}
      onClose={close}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (pending || !name.trim()) return
          setPending(true)
          setError(null)
          void onSave(
            editor.folder
              ? {
                  action: 'rename',
                  workspace_id: editor.workspaceId,
                  folder_id: editor.folder.id,
                  name: name.trim(),
                }
              : {
                  action: 'create',
                  workspace_id: editor.workspaceId,
                  name: name.trim(),
                },
          )
            .then(onClose)
            .catch((error: unknown) =>
              setError(
                error instanceof Error
                  ? error.message
                  : 'Could not save folder',
              ),
            )
            .finally(() => setPending(false))
        }}
      >
        <Input
          aria-label="Folder name"
          placeholder="e.g. Chores"
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          disabled={pending}
        />
        {error ? (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={close}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !name.trim()}>
            {pending ? 'Saving…' : editor.folder ? 'Save' : 'Create'}
          </Button>
        </div>
      </form>
    </FolderDialog>
  )
}

export function MoveTaskDialog({
  task,
  folders,
  onSave,
  onClose,
}: {
  task: DraggedTask
  folders: readonly ProjectFolder[]
  onSave: (mutation: ProjectFolderMutation) => Promise<void>
  onClose: () => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const current =
    folders.find(
      (folder) =>
        folder.workspace_id === task.workspaceId &&
        folder.thread_ids.includes(task.threadId),
    )?.id ?? null
  const move = (folderId: string | null) => {
    if (pending) return
    setPending(true)
    setError(null)
    void onSave({
      workspace_id: task.workspaceId,
      action: 'move_thread',
      thread_id: task.threadId,
      folder_id: folderId,
    })
      .then(onClose)
      .catch((error: unknown) =>
        setError(
          error instanceof Error ? error.message : 'Could not move task',
        ),
      )
      .finally(() => setPending(false))
  }
  return (
    <FolderDialog
      title="Move task"
      onClose={() => {
        if (!pending) onClose()
      }}
    >
      <div className="max-h-72 overflow-y-auto">
        <button
          className="fd-focus flex min-h-9 w-full items-center gap-2 rounded-[var(--fd-radius-sm)] px-2.5 text-left text-sm text-fg-secondary hover:bg-interactive-hover"
          disabled={pending || current === null}
          onClick={() => move(null)}
        >
          <FolderOpen className="h-4 w-4" />
          Project root
        </button>
        {folders
          .filter((folder) => folder.workspace_id === task.workspaceId)
          .map((folder) => (
            <button
              key={folder.id}
              className="fd-focus flex min-h-9 w-full items-center gap-2 rounded-[var(--fd-radius-sm)] px-2.5 text-left text-sm text-fg-secondary hover:bg-interactive-hover"
              disabled={pending || folder.id === current}
              onClick={() => move(folder.id)}
            >
              <FolderClosed className="h-4 w-4" />
              <span className="truncate">{folder.name}</span>
            </button>
          ))}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <Button
        variant="ghost"
        className="mt-4"
        onClick={onClose}
        disabled={pending}
      >
        Cancel
      </Button>
    </FolderDialog>
  )
}
