import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import {
  ArrowUpRight,
  ClipboardCopy,
  Copy,
  FolderOpen,
  Save,
  SquareCode,
} from 'lucide-react'

import { cn } from '@falcondeck/ui'

import { MenuRow, MenuSurface, type MenuPosition } from './menu-surface'

export type LocalPathAction =
  | 'open'
  | 'reveal'
  | 'open-with'
  | 'save-as'
  | 'copy-contents'

export type LocalPathHandler = (
  action: LocalPathAction,
  path: string,
  editorId?: string,
) => void | Promise<void>

/** An editor the desktop detected locally, e.g. `{ id: 'zed', name: 'Zed' }`. */
export type LocalPathEditor = { id: string; name: string }

export type LocalPathKind = 'file' | 'directory'

export type LocalPathKindResolver = (
  path: string,
) => Promise<LocalPathKind | null>

type LocalPathMenuState = {
  path: string
  x: number
  y: number
}

type LocalPathContextValue = {
  onLocalPath: LocalPathHandler
  openMenu: (path: string, position: MenuPosition) => void
}

const LocalPathContext = createContext<LocalPathContextValue | null>(null)

const NO_EDITORS: readonly LocalPathEditor[] = []

function revealInFolderLabel() {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Mac|darwin/i.test(ua) && !/iPhone|iPad|iPod/i.test(ua)) {
    return 'Reveal in Finder'
  }
  if (/Windows/i.test(ua)) return 'Show in Explorer'
  return 'Show in folder'
}

async function copyTextToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
}

export function LocalPathProvider({
  onLocalPath,
  editors = NO_EDITORS,
  describePath = null,
  children,
}: {
  onLocalPath?: LocalPathHandler | null
  /** Editors offered as "Open in …" actions; the desktop detects these. */
  editors?: readonly LocalPathEditor[]
  /** Reports whether a path is a file or a directory, so file-only actions
      (save, copy contents) can hide for directories. */
  describePath?: LocalPathKindResolver | null
  children: ReactNode
}) {
  const [menu, setMenu] = useState<LocalPathMenuState | null>(null)
  const [menuKind, setMenuKind] = useState<LocalPathKind | null>(null)
  const handler = onLocalPath ?? null

  const openMenu = useCallback((path: string, position: MenuPosition) => {
    setMenu({ path, x: position.x, y: position.y })
    setMenuKind(null)
  }, [])

  const closeMenu = useCallback(() => setMenu(null), [])

  // File-only rows render optimistically and retract once the path is known
  // to be a directory; most transcript paths are files, and the stat is fast.
  useEffect(() => {
    if (!menu || !describePath) return
    let cancelled = false
    void describePath(menu.path)
      .then((kind) => {
        if (!cancelled) setMenuKind(kind)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [describePath, menu])

  const value = useMemo(
    () => (handler ? { onLocalPath: handler, openMenu } : null),
    [handler, openMenu],
  )

  return (
    <LocalPathContext.Provider value={value}>
      {children}
      {menu && handler ? (
        <LocalPathMenu
          menu={menu}
          kind={menuKind}
          editors={editors}
          onLocalPath={handler}
          onClose={closeMenu}
        />
      ) : null}
    </LocalPathContext.Provider>
  )
}

export function useLocalPathHandler(): LocalPathContextValue | null {
  return useContext(LocalPathContext)
}

const INLINE_CODE_CLASS =
  '[overflow-wrap:anywhere] rounded-[var(--fd-radius-sm)] bg-surface-4 px-1.5 py-px font-mono text-[0.9em]'

export function LocalPathLink({
  path,
  variant = 'text',
  className,
  children,
}: {
  path: string
  variant?: 'text' | 'code'
  className?: string
  children?: ReactNode
}) {
  const context = useLocalPathHandler()
  const label = children ?? path

  if (!context) {
    if (variant === 'code') {
      return <code className={cn(INLINE_CODE_CLASS, className)}>{label}</code>
    }
    return <span className={className}>{label}</span>
  }

  const { onLocalPath, openMenu } = context

  const handleOpen = () => {
    void onLocalPath('open', path)
  }

  return (
    <span
      role="link"
      tabIndex={0}
      title={`Open ${path}`}
      aria-label={`Open ${path}`}
      onClick={(event) => {
        const selection = window.getSelection()
        if (selection && !selection.isCollapsed && selection.toString().length > 0) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        handleOpen()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        openMenu(path, { x: event.clientX, y: event.clientY })
      }}
      onKeyDown={(event: ReactKeyboardEvent<HTMLSpanElement>) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          handleOpen()
        }
      }}
      className={cn(
        'fd-focus cursor-pointer select-text rounded-[var(--fd-radius-sm)] underline decoration-dotted decoration-fg-faint underline-offset-2',
        'transition-colors hover:text-accent hover:decoration-accent',
        variant === 'code' && INLINE_CODE_CLASS,
        className,
      )}
    >
      {label}
    </span>
  )
}

function LocalPathMenu({
  menu,
  kind,
  editors,
  onLocalPath,
  onClose,
}: {
  menu: LocalPathMenuState
  kind: LocalPathKind | null
  editors: readonly LocalPathEditor[]
  onLocalPath: LocalPathHandler
  onClose: () => void
}) {
  const iconClassName = 'h-3.5 w-3.5 text-fg-muted'
  // Directories never gain file-only rows, but until the stat answers the
  // menu behaves like the common case: a file.
  const isFile = kind !== 'directory'
  const runAction = (action: LocalPathAction, editorId?: string) => {
    onClose()
    if (editorId) {
      void onLocalPath(action, menu.path, editorId)
    } else {
      void onLocalPath(action, menu.path)
    }
  }

  return (
    <MenuSurface
      position={{ x: menu.x, y: menu.y }}
      itemCount={3 + editors.length + (isFile ? 2 : 0)}
      ariaLabel={`Actions for ${menu.path}`}
      onClose={onClose}
    >
      <MenuRow
        icon={<ArrowUpRight className={iconClassName} />}
        label="Open"
        onClick={() => runAction('open')}
      />
      {editors.map((editor) => (
        <MenuRow
          key={editor.id}
          icon={<SquareCode className={iconClassName} />}
          label={`Open in ${editor.name}`}
          onClick={() => runAction('open-with', editor.id)}
        />
      ))}
      {isFile ? (
        <MenuRow
          icon={<Save className={iconClassName} />}
          label="Save As…"
          onClick={() => runAction('save-as')}
        />
      ) : null}
      <MenuRow
        icon={<Copy className={iconClassName} />}
        label="Copy Path"
        onClick={() => {
          void copyTextToClipboard(menu.path).finally(onClose)
        }}
      />
      {isFile ? (
        <MenuRow
          icon={<ClipboardCopy className={iconClassName} />}
          label="Copy File Contents"
          onClick={() => runAction('copy-contents')}
        />
      ) : null}
      <MenuRow
        icon={<FolderOpen className={iconClassName} />}
        label={revealInFolderLabel()}
        onClick={() => runAction('reveal')}
      />
    </MenuSurface>
  )
}
