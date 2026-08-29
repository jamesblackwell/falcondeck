import { createContext, useContext, useMemo } from 'react'

import { cn } from '@falcondeck/ui'

/* ================================================================
   Opening a file in the host's side panel from the transcript.

   The transcript is many components deep and each layer is memoized,
   so threading a callback down as a prop would defeat that. Context
   carries it instead: `Conversation` publishes the host app's handler
   once, and any descendant that knows a file path can offer to open
   it. A null handler means "this client has nowhere to open it" and
   paths render as inert text.
   ================================================================ */

export type OpenFileDiff = (filePath: string, view?: 'changes' | 'files') => void

const FileDiffContext = createContext<OpenFileDiff | null>(null)

export function FileDiffProvider({
  onOpenFile,
  children,
}: {
  onOpenFile?: OpenFileDiff | null
  children: React.ReactNode
}) {
  // Memoized so the provider does not invalidate every consumer on each
  // transcript render when the host passes a stable callback.
  const value = useMemo(() => onOpenFile ?? null, [onOpenFile])
  return <FileDiffContext.Provider value={value}>{children}</FileDiffContext.Provider>
}

export function useOpenFileDiff(): OpenFileDiff | null {
  return useContext(FileDiffContext)
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
  children,
  className,
}: {
  filePath: string
  children?: React.ReactNode
  className?: string
}) {
  const openFile = useOpenFileDiff()
  const label = children ?? filePath

  if (!openFile) {
    return <span className={className}>{label}</span>
  }

  return (
    <button
      type="button"
      title={`Open ${filePath} in the file browser`}
      onClick={(event) => {
        event.stopPropagation()
        openFile(filePath, 'files')
      }}
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
