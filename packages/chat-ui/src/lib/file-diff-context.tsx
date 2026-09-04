import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

import { cn } from '@falcondeck/ui'

import { useLocalPathHandler } from './local-path-context'

/* ================================================================
   Opening a file in the host's side panel from the transcript.

   The transcript is many components deep and each layer is memoized,
   so threading a callback down as a prop would defeat that. Context
   carries it instead: `Conversation` publishes the host app's handler
   once, and any descendant that knows a file path can offer to open
   it. A null handler means "this client has nowhere to open it" and
   paths render as inert text.

   The host can also say where the workspace lives on disk and whether
   a relative path names a real file. Those let agent prose like
   `src/app.ts:12` or an absolute path inside the checkout open in the
   rail instead of staying plain or bouncing out to the OS.
   ================================================================ */

export type OpenFileDiff = (
  filePath: string,
  view?: 'changes' | 'files',
  line?: number | null,
) => void

/**
 * Whether a workspace-relative path names an existing file. `null` means the
 * host cannot tell (its listing was truncated), so the caller decides.
 */
export type WorkspaceFileResolver = (
  filePath: string,
) => boolean | null | Promise<boolean | null>

type FileDiffContextValue = {
  openFile: OpenFileDiff
  workspaceRoot: string | null
  resolveWorkspaceFile: WorkspaceFileResolver | null
  /** Bumps when the host's file index changes so cached lookups re-run. */
  workspaceFilesVersion: number
}

const FileDiffContext = createContext<FileDiffContextValue | null>(null)

export function FileDiffProvider({
  onOpenFile,
  workspaceRoot = null,
  resolveWorkspaceFile = null,
  workspaceFilesVersion = 0,
  children,
}: {
  onOpenFile?: OpenFileDiff | null
  /** Absolute path of the workspace checkout, so absolute paths inside it
      open in the rail rather than through the OS. */
  workspaceRoot?: string | null
  resolveWorkspaceFile?: WorkspaceFileResolver | null
  workspaceFilesVersion?: number
  children: React.ReactNode
}) {
  // Memoized so the provider does not invalidate every consumer on each
  // transcript render when the host passes stable callbacks.
  const value = useMemo<FileDiffContextValue | null>(
    () =>
      onOpenFile
        ? {
            openFile: onOpenFile,
            workspaceRoot,
            resolveWorkspaceFile,
            workspaceFilesVersion,
          }
        : null,
    [onOpenFile, resolveWorkspaceFile, workspaceFilesVersion, workspaceRoot],
  )
  return <FileDiffContext.Provider value={value}>{children}</FileDiffContext.Provider>
}

export function useOpenFileDiff(): OpenFileDiff | null {
  return useContext(FileDiffContext)?.openFile ?? null
}

export function useFileDiffContext(): FileDiffContextValue | null {
  return useContext(FileDiffContext)
}

/**
 * Whether `filePath` exists in the workspace, as far as the host knows.
 * `undefined` while an async lookup is still in flight; `null` when the host
 * cannot say. Without a resolver the answer is always `null`.
 */
export function useWorkspaceFileExists(
  filePath: string,
): boolean | null | undefined {
  const context = useFileDiffContext()
  const resolver = context?.resolveWorkspaceFile ?? null
  const version = context?.workspaceFilesVersion ?? 0
  const immediate = useMemo(() => {
    if (!resolver) return null
    const result = resolver(filePath)
    return result instanceof Promise ? undefined : result
  }, [filePath, resolver, version])
  const [resolved, setResolved] = useState<{
    key: string
    value: boolean | null
  } | null>(null)
  const key = `${version}:${filePath}`

  useEffect(() => {
    if (immediate !== undefined || !resolver) return
    let cancelled = false
    Promise.resolve(resolver(filePath))
      .then((value) => {
        if (!cancelled) setResolved({ key, value })
      })
      .catch(() => {
        if (!cancelled) setResolved({ key, value: null })
      })
    return () => {
      cancelled = true
    }
  }, [filePath, immediate, key, resolver])

  if (immediate !== undefined) return immediate
  return resolved?.key === key ? resolved.value : undefined
}

/**
 * A file path that opens its diff in the host's side panel when the host
 * supports it, and is plain text when it does not.
 */
export function FileDiffLink({
  filePath,
  label,
  className,
}: {
  filePath: string
  label?: string
  className?: string
}) {
  const openFileDiff = useOpenFileDiff()
  const text = label ?? filePath

  if (!openFileDiff) {
    return <span className={className}>{text}</span>
  }

  return (
    <button
      type="button"
      title={`Open ${filePath} in the changes panel`}
      onClick={(event) => {
        // Nested inside collapsible triggers; opening the panel must not also
        // toggle the row the path sits on.
        event.stopPropagation()
        openFileDiff(filePath)
      }}
      className={cn(
        'fd-focus rounded-[var(--fd-radius-sm)] underline decoration-dotted decoration-fg-faint underline-offset-2',
        'transition-colors hover:text-accent hover:decoration-accent',
        className,
      )}
    >
      {text}
    </button>
  )
}

/** A workspace-relative path that opens the editable file browser preview. */
export function WorkspaceFileLink({
  filePath,
  line = null,
  localPath,
  children,
  className,
}: {
  filePath: string
  /** 1-based line the viewer should scroll to. */
  line?: number | null
  /** Absolute target retained from Markdown so desktop right-click actions
      can operate on the real file while left click stays in the file rail. */
  localPath?: string | null
  children?: React.ReactNode
  className?: string
}) {
  const openFile = useOpenFileDiff()
  const localPathHandler = useLocalPathHandler()
  const label = children ?? filePath
  const target = line ? `${filePath}:${line}` : filePath

  if (!openFile) {
    return <span className={className}>{label}</span>
  }

  return (
    <button
      type="button"
      title={`Open ${target} in the file browser`}
      onClick={(event) => {
        event.stopPropagation()
        openFile(filePath, 'files', line)
      }}
      onContextMenu={
        localPath && localPathHandler
          ? (event) => {
              event.preventDefault()
              event.stopPropagation()
              localPathHandler.openMenu(localPath, {
                x: event.clientX,
                y: event.clientY,
              })
            }
          : undefined
      }
      className={cn(
        'fd-focus rounded-[var(--fd-radius-sm)] underline decoration-dotted decoration-fg-faint underline-offset-2',
        'transition-colors hover:text-accent hover:decoration-accent',
        className,
      )}
    >
      {label}
    </button>
  )
}
