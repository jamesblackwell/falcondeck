import * as React from 'react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronRight,
  FolderClosed,
  FolderOpen,
  FolderInput,
  Pencil,
  SquarePen,
  Trash2,
} from 'lucide-react'
import {
  EMPTY_PROJECT_FOLDERS,
  type ProjectFolder,
  type ProjectFolderMutation,
} from '@falcondeck/client-core'
import { Button, cn } from '@falcondeck/ui'

export type ProjectFolderControls = {
  projectFolders?: readonly ProjectFolder[]
  onProjectFolderMutation?: (mutation: ProjectFolderMutation) => Promise<void>
  onNewThreadInFolder?: (workspaceId: string, folderId: string) => Promise<void>
}

import {
  FolderEditor,
  MoveTaskDialog,
  type FolderEditorTarget as Editor,
  type FolderTaskTarget as DraggedTask,
} from './project-folder-dialogs'
type TaskDropTarget = { workspaceId: string; folderId: string | null }
type FolderContext = ProjectFolderControls & {
  folders: readonly ProjectFolder[]
  draggedTask: DraggedTask | null
  dropTarget: TaskDropTarget | null
  /** Pointer-down handler for a task row; becomes a drag past a few pixels. */
  startTaskDrag: (
    event: React.PointerEvent<HTMLElement>,
    task: DraggedTask,
    label: string,
  ) => void
  edit: (editor: Editor) => void
  move: (task: DraggedTask) => void
  menu: (folder: ProjectFolder, x: number, y: number) => void
  perform: (mutation: ProjectFolderMutation) => void
}
const Context = createContext<FolderContext>({
  folders: EMPTY_PROJECT_FOLDERS,
  draggedTask: null,
  dropTarget: null,
  startTaskDrag: () => {},
  edit: () => {},
  move: () => {},
  menu: () => {},
  perform: () => {},
})
export const useProjectFolders = () => useContext(Context)
const TASK_DRAG_THRESHOLD_PX = 4

/** The innermost folder or project header under the pointer that accepts
 * tasks from `workspaceId`. HTML5 drag-and-drop never delivers drops in the
 * Tauri webview, so drags hit-test with pointer events instead. */
function taskDropTargetAt(
  x: number,
  y: number,
  workspaceId: string,
): TaskDropTarget | null {
  const element = document
    .elementFromPoint?.(x, y)
    ?.closest<HTMLElement>('[data-task-drop-workspace]')
  if (!element || element.dataset.taskDropWorkspace !== workspaceId) return null
  return { workspaceId, folderId: element.dataset.taskDropFolder || null }
}
const MENU_ITEM =
  'fd-focus flex min-h-9 w-full items-center gap-2 rounded-[var(--fd-radius-sm)] px-2.5 text-left text-sm text-fg-secondary hover:bg-interactive-hover'

export function ProjectFoldersProvider({
  children,
  projectFolders = EMPTY_PROJECT_FOLDERS,
  onProjectFolderMutation,
  onNewThreadInFolder,
}: ProjectFolderControls & { children: React.ReactNode }) {
  const [draggedTask, setDraggedTask] = useState<DraggedTask | null>(null)
  const [dropTarget, setDropTarget] = useState<TaskDropTarget | null>(null)
  const [dragGhost, setDragGhost] = useState<{
    label: string
    x: number
    y: number
  } | null>(null)
  const endTaskDragRef = useRef<(() => void) | null>(null)
  useEffect(() => () => endTaskDragRef.current?.(), [])
  const [editor, setEditor] = useState<Editor | null>(null)
  const [moveTarget, setMoveTarget] = useState<DraggedTask | null>(null)
  const [menu, setMenu] = useState<{
    folder: ProjectFolder
    x: number
    y: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const perform = useCallback(
    (mutation: ProjectFolderMutation) => {
      setError(null)
      void onProjectFolderMutation?.(mutation).catch((error: unknown) =>
        setError(
          error instanceof Error ? error.message : 'Could not update folder',
        ),
      )
    },
    [onProjectFolderMutation],
  )
  const startTaskDrag = useCallback(
    (
      event: React.PointerEvent<HTMLElement>,
      task: DraggedTask,
      label: string,
    ) => {
      if (event.button !== 0 || !onProjectFolderMutation) return
      endTaskDragRef.current?.()
      const { pointerId, clientX: startX, clientY: startY } = event
      let active = false
      let target: TaskDropTarget | null = null
      const finish = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        window.removeEventListener('keydown', onKeyDown, true)
        endTaskDragRef.current = null
        setDraggedTask(null)
        setDropTarget(null)
        setDragGhost(null)
      }
      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== pointerId) return
        if (!active) {
          const distance = Math.hypot(move.clientX - startX, move.clientY - startY)
          if (distance < TASK_DRAG_THRESHOLD_PX) return
          active = true
          window.getSelection()?.removeAllRanges()
          setDraggedTask(task)
        }
        move.preventDefault()
        const next = taskDropTargetAt(move.clientX, move.clientY, task.workspaceId)
        if (
          next?.workspaceId !== target?.workspaceId ||
          next?.folderId !== target?.folderId
        ) {
          target = next
          setDropTarget(next)
        }
        setDragGhost({ label, x: move.clientX, y: move.clientY })
      }
      const onUp = (up: PointerEvent) => {
        if (up.pointerId !== pointerId) return
        const dropped = active ? target : null
        finish()
        if (!active) return
        // The release would otherwise click whatever row it ended on.
        const swallow = (click: MouseEvent) => {
          click.preventDefault()
          click.stopPropagation()
        }
        window.addEventListener('click', swallow, { capture: true, once: true })
        window.setTimeout(
          () => window.removeEventListener('click', swallow, { capture: true }),
          0,
        )
        if (dropped) {
          perform({
            action: 'move_thread',
            workspace_id: dropped.workspaceId,
            thread_id: task.threadId,
            folder_id: dropped.folderId,
          })
        }
      }
      const onCancel = (cancel: PointerEvent) => {
        if (cancel.pointerId === pointerId) finish()
      }
      const onKeyDown = (key: KeyboardEvent) => {
        if (key.key !== 'Escape' || !active) return
        key.preventDefault()
        key.stopPropagation()
        finish()
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
      window.addEventListener('keydown', onKeyDown, true)
      endTaskDragRef.current = finish
    },
    [onProjectFolderMutation, perform],
  )
  const startTask = useCallback(
    async (workspaceId: string, folderId: string) => {
      try {
        await onNewThreadInFolder?.(workspaceId, folderId)
      } catch (error) {
        setError(
          error instanceof Error ? error.message : 'Could not create task',
        )
      }
    },
    [onNewThreadInFolder],
  )
  const value = useMemo<FolderContext>(
    () => ({
      folders: projectFolders,
      onProjectFolderMutation,
      onNewThreadInFolder: onNewThreadInFolder ? startTask : undefined,
      draggedTask,
      dropTarget,
      startTaskDrag,
      edit: setEditor,
      move: setMoveTarget,
      menu: (folder, x, y) => setMenu({ folder, x, y }),
      perform,
    }),
    [
      projectFolders,
      onProjectFolderMutation,
      onNewThreadInFolder,
      startTask,
      draggedTask,
      dropTarget,
      startTaskDrag,
      perform,
    ],
  )
  return (
    <Context.Provider value={value}>
      {children}
      {dragGhost
        ? createPortal(
            <div
              aria-hidden="true"
              className="pointer-events-none fixed z-50 max-w-60 truncate rounded-[var(--fd-radius-md)] border border-border-default bg-surface-2 px-2.5 py-1.5 text-sm text-fg-primary shadow-[var(--fd-shadow-lg)]"
              style={{ left: dragGhost.x + 12, top: dragGhost.y + 8 }}
            >
              {dragGhost.label}
            </div>,
            document.body,
          )
        : null}
      {error
        ? createPortal(
            <div
              role="alert"
              className="fixed bottom-4 left-4 z-50 flex max-w-sm items-center gap-2 rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-2 p-3 text-sm text-danger shadow-[var(--fd-shadow-lg)]"
            >
              {error}
              <Button size="sm" variant="ghost" onClick={() => setError(null)}>
                Dismiss
              </Button>
            </div>,
            document.body,
          )
        : null}
      {editor && onProjectFolderMutation ? (
        <FolderEditor
          key={editor.folder?.id ?? editor.workspaceId}
          editor={editor}
          onSave={onProjectFolderMutation}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {moveTarget && onProjectFolderMutation ? (
        <MoveTaskDialog
          task={moveTarget}
          folders={projectFolders}
          onSave={onProjectFolderMutation}
          onClose={() => setMoveTarget(null)}
        />
      ) : null}
      {menu ? (
        <FolderMenu
          folder={menu.folder}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </Context.Provider>
  )
}

function FolderMenu({
  folder,
  x,
  y,
  onClose,
}: {
  folder: ProjectFolder
  x: number
  y: number
  onClose: () => void
}) {
  const controls = useProjectFolders()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const close = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', key)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', key)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={`Options for ${folder.name}`}
      className="fixed z-50 w-56 rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-2 p-1 shadow-[var(--fd-shadow-lg)]"
      style={{
        left: Math.max(8, Math.min(x, window.innerWidth - 232)),
        top: Math.max(8, Math.min(y, window.innerHeight - 128)),
      }}
      onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const items = Array.from(
          ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [],
        )
        const current = items.indexOf(
          document.activeElement as HTMLButtonElement,
        )
        const index =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : (current +
                  (event.key === 'ArrowDown' ? 1 : -1) +
                  items.length) %
                items.length
        items[index]?.focus()
      }}
    >
      {controls.onNewThreadInFolder ? (
        <button
          role="menuitem"
          className={MENU_ITEM}
          onClick={() => {
            onClose()
            void controls.onNewThreadInFolder?.(folder.workspace_id, folder.id)
          }}
        >
          <SquarePen className="h-4 w-4" />
          New task
        </button>
      ) : null}
      <button
        role="menuitem"
        className={MENU_ITEM}
        onClick={() => {
          onClose()
          controls.edit({ workspaceId: folder.workspace_id, folder })
        }}
      >
        <Pencil className="h-4 w-4" />
        Rename folder
      </button>
      <button
        role="menuitem"
        className={cn(MENU_ITEM, 'text-danger')}
        onClick={() => {
          onClose()
          controls.perform({
            action: 'delete',
            workspace_id: folder.workspace_id,
            folder_id: folder.id,
          })
        }}
      >
        <Trash2 className="h-4 w-4" />
        Delete folder
      </button>
    </div>,
    document.body,
  )
}

export type TaskDropTargetProps = {
  'data-task-drop-workspace': string
  'data-task-drop-folder': string
}

/** Marks a folder (or, with `folderId` null, the project root) as a place a
 * dragged task can land. */
export function useTaskDropTarget(
  workspaceId: string,
  folderId: string | null,
) {
  const { dropTarget } = useProjectFolders()
  const props: TaskDropTargetProps = {
    'data-task-drop-workspace': workspaceId,
    'data-task-drop-folder': folderId ?? '',
  }
  return {
    over:
      dropTarget?.workspaceId === workspaceId &&
      dropTarget.folderId === folderId,
    props,
  }
}

export function ProjectFolderSection({
  folder,
  count,
  children,
}: {
  folder: ProjectFolder
  count: number
  children: React.ReactNode
}) {
  const controls = useProjectFolders()
  const drop = useTaskDropTarget(folder.workspace_id, folder.id)
  return (
    <section
      {...drop.props}
      className="min-w-0 pl-3"
      data-project-folder={folder.id}
    >
      <div
        className={cn(
          'group flex items-center gap-1 rounded-[var(--fd-radius-md)]',
          drop.over && 'bg-interactive-selected ring-1 ring-accent',
        )}
        onContextMenu={(event) => {
          event.preventDefault()
          controls.menu(folder, event.clientX, event.clientY)
        }}
      >
        <button
          className="fd-focus-inset flex min-w-0 flex-1 items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1.5 text-sm text-fg-secondary hover:bg-interactive-hover"
          aria-label={folder.name}
          aria-expanded={!folder.collapsed}
          onClick={() =>
            controls.perform({
              action: 'set_collapsed',
              workspace_id: folder.workspace_id,
              folder_id: folder.id,
              collapsed: !folder.collapsed,
            })
          }
        >
          <ChevronRight
            aria-hidden
            className={cn('h-3 w-3 shrink-0', !folder.collapsed && 'rotate-90')}
          />
          {folder.collapsed ? (
            <FolderClosed
              aria-hidden
              className="h-3.5 w-3.5 shrink-0 text-fg-muted"
            />
          ) : (
            <FolderOpen
              aria-hidden
              className="h-3.5 w-3.5 shrink-0 text-fg-muted"
            />
          )}
          <span className="truncate">{folder.name}</span>
          <span className="ml-auto text-xs tabular-nums text-fg-muted">
            {count}
          </span>
        </button>
        {controls.onNewThreadInFolder ? (
          <button
            aria-label={`New task in ${folder.name}`}
            title={`New task in ${folder.name}`}
            className="fd-focus mr-1 rounded-[var(--fd-radius-sm)] p-1 text-fg-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => {
              void controls.onNewThreadInFolder?.(
                folder.workspace_id,
                folder.id,
              )
            }}
          >
            <SquarePen aria-hidden className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {!folder.collapsed ? (
        <div className="pl-3">
          {count === 0 ? (
            <p className="px-2.5 py-2 text-xs text-fg-muted">No tasks yet</p>
          ) : (
            children
          )}
        </div>
      ) : null}
    </section>
  )
}

export function ProjectFolderMoveMenuItem({
  workspaceId,
  threadId,
  onClose,
}: DraggedTask & { onClose: () => void }) {
  const controls = useProjectFolders()
  if (
    !controls.onProjectFolderMutation ||
    !controls.folders.some((folder) => folder.workspace_id === workspaceId)
  )
    return null
  return (
    <button
      role="menuitem"
      className={MENU_ITEM}
      onClick={() => {
        onClose()
        controls.move({ workspaceId, threadId })
      }}
    >
      <FolderInput className="h-3.5 w-3.5 text-fg-muted" />
      Move to folder…
    </button>
  )
}
