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
type FolderContext = ProjectFolderControls & {
  folders: readonly ProjectFolder[]
  draggedTask: DraggedTask | null
  setDraggedTask: (task: DraggedTask | null) => void
  edit: (editor: Editor) => void
  move: (task: DraggedTask) => void
  menu: (folder: ProjectFolder, x: number, y: number) => void
  perform: (mutation: ProjectFolderMutation) => void
}
const Context = createContext<FolderContext>({
  folders: EMPTY_PROJECT_FOLDERS,
  draggedTask: null,
  setDraggedTask: () => {},
  edit: () => {},
  move: () => {},
  menu: () => {},
  perform: () => {},
})
export const useProjectFolders = () => useContext(Context)
export const TASK_DRAG_TYPE = 'application/x-falcondeck-task'
const MENU_ITEM =
  'fd-focus flex min-h-9 w-full items-center gap-2 rounded-[var(--fd-radius-sm)] px-2.5 text-left text-sm text-fg-secondary hover:bg-interactive-hover'

export function ProjectFoldersProvider({
  children,
  projectFolders = EMPTY_PROJECT_FOLDERS,
  onProjectFolderMutation,
  onNewThreadInFolder,
}: ProjectFolderControls & { children: React.ReactNode }) {
  const [draggedTask, setDraggedTask] = useState<DraggedTask | null>(null)
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
      setDraggedTask,
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
      perform,
    ],
  )
  return (
    <Context.Provider value={value}>
      {children}
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

export function useTaskDropTarget(
  workspaceId: string,
  folderId: string | null,
) {
  const { draggedTask, setDraggedTask, perform, onProjectFolderMutation } =
    useProjectFolders()
  const [over, setOver] = useState(false)
  const accepts = Boolean(
    onProjectFolderMutation && draggedTask?.workspaceId === workspaceId,
  )
  useEffect(() => {
    if (!accepts) setOver(false)
  }, [accepts])
  return {
    over: over && accepts,
    props: {
      onDragOver: (event: React.DragEvent) => {
        if (!accepts) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        setOver(true)
      },
      onDragLeave: (event: React.DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOver(false)
      },
      onDrop: (event: React.DragEvent) => {
        setOver(false)
        if (!accepts || !draggedTask) return
        event.preventDefault()
        event.stopPropagation()
        perform({
          action: 'move_thread',
          workspace_id: workspaceId,
          thread_id: draggedTask.threadId,
          folder_id: folderId,
        })
        setDraggedTask(null)
      },
    },
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
