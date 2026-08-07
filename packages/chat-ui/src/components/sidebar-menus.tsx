import * as React from 'react'
import { memo, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Archive, Check, Copy, Pin, PinOff, SquarePen, Trash2 } from 'lucide-react'

import type { ThreadSummary } from '@falcondeck/client-core'
import { Button, Input, cn } from '@falcondeck/ui'

// Must match the rendered menu width below (`w-52`), or the viewport clamp
// lets the menu overflow the right edge.
const THREAD_MENU_WIDTH_PX = 208
const THREAD_MENU_VIEWPORT_PADDING_PX = 8
const THREAD_MENU_ROW_HEIGHT_PX = 36
const THREAD_MENU_SEPARATOR_HEIGHT_PX = 9

export type ThreadContextMenuState = {
  workspaceId: string
  thread: ThreadSummary
  x: number
  y: number
}

export type WorkspaceContextMenuState = {
  workspaceId: string
  path: string
  x: number
  y: number
}

async function copyTextToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Clipboard API can be unavailable in older webviews; fall back to execCommand.
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

function ThreadMenuItem({
  icon,
  label,
  destructive = false,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  destructive?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'fd-focus-inset flex h-9 w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2.5 text-left text-[length:var(--fd-text-sm)]',
        destructive
          ? 'text-danger hover:bg-danger-muted focus-visible:bg-danger-muted'
          : 'text-fg-primary hover:bg-surface-3 focus-visible:bg-surface-3',
      )}
    >
      <span aria-hidden="true" className="flex shrink-0 items-center">
        {icon}
      </span>
      {label}
    </button>
  )
}

export const ThreadContextMenu = memo(
  function ThreadContextMenu({
    target,
    workspacePath,
    canRename,
    canArchive,
    canDelete,
    canPin,
    canMarkRead,
    onClose,
    onRename,
    onArchive,
    onDelete,
    onTogglePin,
    onMarkRead,
    menuRef,
  }: {
    target: ThreadContextMenuState | null
    workspacePath: string | null
    canRename: boolean
    canArchive: boolean
    canDelete: boolean
    canPin: boolean
    canMarkRead: boolean
    onClose: () => void
    onRename: () => void
    onArchive: () => void
    onDelete: () => void
    onTogglePin: () => void
    onMarkRead: () => void
    menuRef: React.RefObject<HTMLDivElement | null>
  }) {
    const [copiedField, setCopiedField] = useState<'path' | 'session' | null>(null)

    useEffect(() => {
      setCopiedField(null)
    }, [target])

    // Focus the first item once per opening. A callback ref would re-run on
    // every render and yank focus back here mid-arrow-keying.
    useEffect(() => {
      if (!target) return
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    }, [menuRef, target])

    if (!target || typeof document === 'undefined') {
      return null
    }

    const showMarkRead = canMarkRead && target.thread.attention.unread
    const sessionId = target.thread.native_session_id
    const iconClassName = 'h-3.5 w-3.5 text-fg-muted'
    const rowCount =
      Number(canPin) +
      Number(canRename) +
      Number(showMarkRead) +
      Number(Boolean(workspacePath)) +
      Number(Boolean(sessionId)) +
      Number(canArchive) +
      Number(canDelete)

    if (rowCount === 0) {
      return null
    }

    const separatorCount =
      Number(Boolean(workspacePath) || Boolean(sessionId)) + Number(canArchive || canDelete)
    const menuHeight =
      THREAD_MENU_VIEWPORT_PADDING_PX * 2 +
      THREAD_MENU_ROW_HEIGHT_PX * rowCount +
      THREAD_MENU_SEPARATOR_HEIGHT_PX * separatorCount
    const left = Math.max(
      THREAD_MENU_VIEWPORT_PADDING_PX,
      Math.min(
        target.x,
        window.innerWidth - THREAD_MENU_WIDTH_PX - THREAD_MENU_VIEWPORT_PADDING_PX,
      ),
    )
    const top = Math.max(
      THREAD_MENU_VIEWPORT_PADDING_PX,
      Math.min(target.y, window.innerHeight - menuHeight - THREAD_MENU_VIEWPORT_PADDING_PX),
    )

    const handleCopy = (field: 'path' | 'session', text: string) => {
      // Closing on failure too: a menu that silently stays open after a click
      // reads as a broken menu, not as a failed copy.
      void copyTextToClipboard(text).then(
        () => {
          setCopiedField(field)
          window.setTimeout(onClose, 600)
        },
        () => onClose(),
      )
    }

    // Arrow keys are what the `menu` role promises assistive tech, and this
    // menu is opened by right-click, so focus has to be moved in explicitly.
    const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') {
        return
      }
      const items = Array.from(
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
      )
      if (items.length === 0) return
      event.preventDefault()
      const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
      const nextIndex =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : event.key === 'ArrowDown'
              ? (currentIndex + 1 + items.length) % items.length
              : (currentIndex - 1 + items.length) % items.length
      items[nextIndex]?.focus()
    }

    return createPortal(
      <div
        ref={menuRef}
        role="menu"
        aria-label={`Actions for ${target.thread.title || 'thread'}`}
        onKeyDown={handleMenuKeyDown}
        className="fixed z-50 w-52 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1 shadow-[var(--fd-shadow-lg)]"
        style={{ left, top }}
      >
        {canPin ? (
          <ThreadMenuItem
            icon={
              target.thread.is_pinned ? (
                <PinOff className={iconClassName} />
              ) : (
                <Pin className={iconClassName} />
              )
            }
            label={target.thread.is_pinned ? 'Unpin chat' : 'Pin chat'}
            onClick={onTogglePin}
          />
        ) : null}
        {canRename ? (
          <ThreadMenuItem
            icon={<SquarePen className={iconClassName} />}
            label="Rename"
            onClick={onRename}
          />
        ) : null}
        {showMarkRead ? (
          <ThreadMenuItem
            icon={<Check className={iconClassName} />}
            label="Mark as read"
            onClick={onMarkRead}
          />
        ) : null}
        {workspacePath || sessionId ? (
          <div role="separator" className="mx-2 my-1 border-t border-border-subtle" />
        ) : null}
        {workspacePath ? (
          <ThreadMenuItem
            icon={
              copiedField === 'path' ? (
                <Check className="h-3.5 w-3.5 text-success" />
              ) : (
                <Copy className={iconClassName} />
              )
            }
            label={copiedField === 'path' ? 'Copied' : 'Copy working directory'}
            onClick={() => handleCopy('path', workspacePath)}
          />
        ) : null}
        {sessionId ? (
          <ThreadMenuItem
            icon={
              copiedField === 'session' ? (
                <Check className="h-3.5 w-3.5 text-success" />
              ) : (
                <Copy className={iconClassName} />
              )
            }
            label={copiedField === 'session' ? 'Copied' : 'Copy session ID'}
            onClick={() => handleCopy('session', sessionId)}
          />
        ) : null}
        {canArchive || canDelete ? (
          <div role="separator" className="mx-2 my-1 border-t border-border-subtle" />
        ) : null}
        {canArchive ? (
          <ThreadMenuItem
            icon={<Archive className="h-3.5 w-3.5" />}
            label="Archive"
            destructive
            onClick={() => {
              onArchive()
              onClose()
            }}
          />
        ) : null}
        {canDelete ? (
          <ThreadMenuItem
            icon={<Trash2 className="h-3.5 w-3.5" />}
            label="Delete"
            destructive
            onClick={onDelete}
          />
        ) : null}
      </div>,
      document.body,
    )
  },
)

export const WorkspaceContextMenu = memo(function WorkspaceContextMenu({
  target,
  onRemove,
  menuRef,
}: {
  target: WorkspaceContextMenuState | null
  onRemove: () => void
  menuRef: React.RefObject<HTMLDivElement | null>
}) {
  if (!target || typeof document === 'undefined') {
    return null
  }

  const projectLabel = target.path.split('/').pop() || target.path
  const menuHeight = THREAD_MENU_VIEWPORT_PADDING_PX * 2 + THREAD_MENU_ROW_HEIGHT_PX
  const left = Math.max(
    THREAD_MENU_VIEWPORT_PADDING_PX,
    Math.min(target.x, window.innerWidth - THREAD_MENU_WIDTH_PX - THREAD_MENU_VIEWPORT_PADDING_PX),
  )
  const top = Math.max(
    THREAD_MENU_VIEWPORT_PADDING_PX,
    Math.min(target.y, window.innerHeight - menuHeight - THREAD_MENU_VIEWPORT_PADDING_PX),
  )

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Actions for ${projectLabel}`}
      className="fixed z-50 w-52 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1 shadow-[var(--fd-shadow-lg)]"
      style={{ left, top }}
    >
      <ThreadMenuItem
        icon={<Trash2 className="h-3.5 w-3.5" />}
        label="Remove project"
        destructive
        onClick={onRemove}
      />
    </div>,
    document.body,
  )
})

export const RemoveWorkspaceDialog = memo(function RemoveWorkspaceDialog({
  target,
  error,
  pending,
  onClose,
  onConfirm,
}: {
  target: { workspaceId: string; path: string } | null
  error: string | null
  pending: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  if (!target || typeof document === 'undefined') {
    return null
  }

  const projectLabel = target.path.split('/').pop() || target.path

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--fd-overlay)] p-4"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return
        onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="fd-remove-workspace-title"
        className="w-full max-w-sm rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 p-5 shadow-[var(--fd-shadow-lg)]"
      >
        <div className="space-y-1">
          <h2
            id="fd-remove-workspace-title"
            className="text-[length:var(--fd-text-lg)] font-semibold text-fg-primary"
          >
            Remove {projectLabel}?
          </h2>
          <p className="truncate text-[length:var(--fd-text-sm)] text-fg-muted" title={target.path}>
            {target.path}
          </p>
        </div>

        <p className="mt-4 text-[length:var(--fd-text-sm)] text-fg-secondary">
          Threads stay in the provider&rsquo;s own history; re-add the folder to restore them.
        </p>
        {error ? (
          <p className="mt-2 text-[length:var(--fd-text-xs)] text-danger">{error}</p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          {/* Focus lands on the non-destructive action: these dialogs open from
              a context menu that unmounts on the same tick, so without this
              focus falls to <body> behind the overlay. */}
          <Button type="button" variant="ghost" autoFocus onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={onConfirm} aria-busy={pending} disabled={pending}>
            {pending ? 'Removing…' : 'Remove'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
})

export const DeleteThreadDialog = memo(function DeleteThreadDialog({
  target,
  error,
  pending,
  onClose,
  onConfirm,
}: {
  target: { workspaceId: string; thread: ThreadSummary } | null
  error: string | null
  pending: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  if (!target || typeof document === 'undefined') {
    return null
  }

  const { variant } = target.thread

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--fd-overlay)] p-4"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return
        onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="fd-delete-thread-title"
        className="w-full max-w-sm rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 p-5 shadow-[var(--fd-shadow-lg)]"
      >
        <div className="space-y-1">
          <h2
            id="fd-delete-thread-title"
            className="text-[length:var(--fd-text-lg)] font-semibold text-fg-primary"
          >
            Delete this thread?
          </h2>
          <p className="truncate text-[length:var(--fd-text-sm)] text-fg-muted">
            {target.thread.title || 'New thread'}
          </p>
        </div>

        <p className="mt-4 text-[length:var(--fd-text-sm)] text-fg-secondary">
          {variant
            ? `This removes the thread and deletes its isolated ${variant.kind} at ${variant.path}. Any uncommitted work there goes with it.`
            : 'This removes the thread from FalconDeck. Archiving keeps it out of the way without deleting it.'}
        </p>
        {error ? (
          <p className="mt-2 text-[length:var(--fd-text-xs)] text-danger">{error}</p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          {/* Focus lands on the non-destructive action: these dialogs open from
              a context menu that unmounts on the same tick, so without this
              focus falls to <body> behind the overlay. */}
          <Button type="button" variant="ghost" autoFocus onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={onConfirm}
            aria-busy={pending}
            disabled={pending}
          >
            {pending ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
})

export const RenameThreadDialog = memo(function RenameThreadDialog({
  target,
  value,
  error,
  pending,
  onChange,
  onClose,
  onSubmit,
}: {
  target: { workspaceId: string; thread: ThreadSummary } | null
  value: string
  error: string | null
  pending: boolean
  onChange: (value: string) => void
  onClose: () => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}) {
  if (!target || typeof document === 'undefined') {
    return null
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--fd-overlay)] p-4"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return
        onClose()
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="fd-rename-thread-title"
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 p-5 shadow-[var(--fd-shadow-lg)]"
      >
        <div className="space-y-1">
          <h2 id="fd-rename-thread-title" className="text-[length:var(--fd-text-lg)] font-semibold text-fg-primary">
            Rename thread
          </h2>
          <p className="truncate text-[length:var(--fd-text-sm)] text-fg-muted">
            {target.thread.title || 'New thread'}
          </p>
        </div>

        <div className="mt-4 space-y-2">
          <Input
            aria-label="Thread title"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            disabled={pending}
          />
          {error ? (
            <p className="text-[length:var(--fd-text-xs)] text-danger">{error}</p>
          ) : null}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          {/* No autoFocus here: the title field above already claims it. */}
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={!value.trim()} aria-busy={pending}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  )
})
