import * as React from 'react'
import { memo, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Archive,
  Check,
  ChevronRight,
  CircleDashed,
  Copy,
  GitFork,
  Pin,
  PinOff,
  Plus,
  Sparkles,
  SquarePen,
  Trash2,
} from 'lucide-react'

import type { ThreadSummary, ThreadTag, WorkspaceColorId } from '@falcondeck/client-core'
import { WORKSPACE_COLOR_IDS, workspaceColorCssVar } from '@falcondeck/client-core'
import { Button, Input, cn } from '@falcondeck/ui'

import { ThreadStageIcon } from './thread-stage-icon'

// Must match the rendered menu width below (`w-60`), or the viewport clamp
// lets the menu overflow the right edge.
const THREAD_MENU_WIDTH_PX = 240
const THREAD_MENU_VIEWPORT_PADDING_PX = 8
const THREAD_MENU_ROW_HEIGHT_PX = 36
const THREAD_MENU_SEPARATOR_HEIGHT_PX = 9
const THREAD_STAGE_SUBMENU_WIDTH_PX = 200
const THREAD_STAGE_SUBMENU_ITEM_HEIGHT_PX = 32
const THREAD_STAGE_SUBMENU_SEPARATOR_HEIGHT_PX = 9
const THREAD_STAGE_SUBMENU_PADDING_PX = 8

export type ThreadContextMenuState = {
  workspaceId: string
  thread: ThreadSummary
  x: number
  y: number
}

const WORKSPACE_MENU_WIDTH_PX = 224
const WORKSPACE_COLOR_SWATCH_SIZE_PX = 22
const WORKSPACE_COLOR_GAP_PX = 6
const WORKSPACE_COLOR_COLUMNS = 6
const WORKSPACE_COLOR_ROWS = Math.ceil((WORKSPACE_COLOR_IDS.length + 1) / WORKSPACE_COLOR_COLUMNS)
const WORKSPACE_COLOR_GRID_HEIGHT_PX =
  WORKSPACE_COLOR_ROWS * WORKSPACE_COLOR_SWATCH_SIZE_PX +
  (WORKSPACE_COLOR_ROWS - 1) * WORKSPACE_COLOR_GAP_PX
const WORKSPACE_COLOR_SECTION_HEIGHT_PX = 28 + WORKSPACE_COLOR_GRID_HEIGHT_PX

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
        'fd-focus-fill flex h-9 w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2.5 text-left text-[length:var(--fd-text-sm)]',
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

export const ThreadContextMenu = memo(function ThreadContextMenu({
  target,
  workspacePath,
  canRename,
  canFork,
  canArchive,
  canDelete,
  canPin,
  canMarkRead,
  canMarkUnread,
  stageOptions,
  selectedStage,
  onClose,
  onRename,
  onFork,
  onArchive,
  onDelete,
  onTogglePin,
  onMarkRead,
  onMarkUnread,
  onSetStage,
  onCreateStage,
  menuRef,
}: {
  target: ThreadContextMenuState | null
  workspacePath: string | null
  canRename: boolean
  /** Whether this thread can be continued in a fresh, independent copy. */
  canFork: boolean
  canArchive: boolean
  canDelete: boolean
  canPin: boolean
  canMarkRead: boolean
  canMarkUnread: boolean
  stageOptions: ThreadTag[]
  selectedStage: ThreadTag | null
  onClose: () => void
  onRename: () => void
  onFork: () => void
  onArchive: () => void
  onDelete: () => void
  onTogglePin: () => void
  onMarkRead: () => void
  onMarkUnread: () => void
  onSetStage: (stage: ThreadTag | null) => void
  onCreateStage?: () => void
  menuRef: React.RefObject<HTMLDivElement | null>
}) {
  const [copiedField, setCopiedField] = useState<'path' | 'session' | null>(
    null,
  )
  const [stageMenuOpen, setStageMenuOpen] = useState(false)
  const [stageMenuSide, setStageMenuSide] = useState<'right' | 'left'>('right')
  const [stageMenuOffsetTop, setStageMenuOffsetTop] = useState(4)
  const [stageMenuMaxHeight, setStageMenuMaxHeight] = useState<number | null>(
    null,
  )
  const stageTriggerRef = useRef<HTMLButtonElement | null>(null)
  const stageMenuRef = useRef<HTMLDivElement | null>(null)

  const positionStageMenu = () => {
    const trigger = stageTriggerRef.current
    const parent = menuRef.current
    if (!trigger || !parent) return
    const parentRect = parent.getBoundingClientRect()
    const spaceRight = window.innerWidth - parentRect.right
    setStageMenuSide(
      spaceRight < THREAD_STAGE_SUBMENU_WIDTH_PX + 8 ? 'left' : 'right',
    )
    const itemCount =
      stageOptions.length + 1 + (onCreateStage ? 1 : 0)
    const separatorCount = onCreateStage ? 1 : 0
    const naturalHeight =
      THREAD_STAGE_SUBMENU_PADDING_PX +
      THREAD_STAGE_SUBMENU_ITEM_HEIGHT_PX * itemCount +
      THREAD_STAGE_SUBMENU_SEPARATOR_HEIGHT_PX * separatorCount
    const availableBelow =
      window.innerHeight -
      (parentRect.top + trigger.offsetTop) -
      THREAD_MENU_VIEWPORT_PADDING_PX
    const availableAbove =
      parentRect.top + trigger.offsetTop + trigger.offsetHeight -
      THREAD_MENU_VIEWPORT_PADDING_PX
    if (naturalHeight <= availableBelow) {
      setStageMenuOffsetTop(trigger.offsetTop)
      setStageMenuMaxHeight(null)
      return
    }
    if (availableBelow >= availableAbove) {
      setStageMenuOffsetTop(trigger.offsetTop)
      setStageMenuMaxHeight(Math.max(availableBelow, THREAD_STAGE_SUBMENU_ITEM_HEIGHT_PX * 4))
      return
    }
    const maxHeight = Math.min(naturalHeight, availableAbove)
    setStageMenuMaxHeight(maxHeight)
    setStageMenuOffsetTop(
      Math.max(
        THREAD_MENU_VIEWPORT_PADDING_PX - parentRect.top,
        trigger.offsetTop + trigger.offsetHeight - maxHeight,
      ),
    )
  }

  useEffect(() => {
    setCopiedField(null)
    setStageMenuOpen(false)
  }, [target])

  // Focus the first item once per opening. A callback ref would re-run on
  // every render and yank focus back here mid-arrow-keying.
  useEffect(() => {
    if (!target) return
    menuRef.current
      ?.querySelector<HTMLButtonElement>(':scope > [role="menuitem"]')
      ?.focus()
  }, [menuRef, target])

  if (!target || typeof document === 'undefined') {
    return null
  }

  const showMarkRead = canMarkRead && target.thread.attention.unread
  // Unread is derived as `last_agent_activity_seq > last_read_seq`, so a thread
  // the agent never replied in can't be made unread at all — hide the row
  // rather than offer an action that would no-op.
  const showMarkUnread =
    canMarkUnread &&
    !target.thread.attention.unread &&
    target.thread.attention.last_agent_activity_seq > 0
  const sessionId = target.thread.native_session_id
  const iconClassName = 'h-3.5 w-3.5 text-fg-muted'
  const canSetStage = stageOptions.length > 0
  const rowCount =
    Number(canPin) +
    Number(canRename) +
    Number(canFork) +
    Number(showMarkRead) +
    Number(showMarkUnread) +
    Number(canSetStage) +
    Number(Boolean(workspacePath)) +
    Number(Boolean(sessionId)) +
    Number(canArchive) +
    Number(canDelete)

  if (rowCount === 0) {
    return null
  }

  const separatorCount =
    Number(Boolean(workspacePath) || Boolean(sessionId)) +
    Number(canArchive || canDelete)
  const menuHeight =
    THREAD_MENU_VIEWPORT_PADDING_PX * 2 +
    THREAD_MENU_ROW_HEIGHT_PX * rowCount +
    THREAD_MENU_SEPARATOR_HEIGHT_PX * separatorCount
  const left = Math.max(
    THREAD_MENU_VIEWPORT_PADDING_PX,
    Math.min(
      target.x,
      window.innerWidth -
        THREAD_MENU_WIDTH_PX -
        THREAD_MENU_VIEWPORT_PADDING_PX,
    ),
  )
  const top = Math.max(
    THREAD_MENU_VIEWPORT_PADDING_PX,
    Math.min(
      target.y,
      window.innerHeight - menuHeight - THREAD_MENU_VIEWPORT_PADDING_PX,
    ),
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
    if (
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return
    }
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        ':scope > [role="menuitem"]',
      ),
    )
    if (items.length === 0) return
    event.preventDefault()
    const currentIndex = items.indexOf(
      document.activeElement as HTMLButtonElement,
    )
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
      className="fixed z-50 w-60 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1 shadow-[var(--fd-shadow-lg)]"
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
      {canFork ? (
        <ThreadMenuItem
          icon={<GitFork className={iconClassName} />}
          label="Fork thread"
          onClick={onFork}
        />
      ) : null}
      {showMarkRead ? (
        <ThreadMenuItem
          icon={<Check className={iconClassName} />}
          label="Mark as read"
          onClick={onMarkRead}
        />
      ) : null}
      {showMarkUnread ? (
        <ThreadMenuItem
          icon={
            // Mirrors the row's own unread dot, sized into the same 3.5 box
            // the lucide icons occupy so the labels stay aligned.
            <span
              className={cn(iconClassName, 'flex items-center justify-center')}
            >
              <span className="h-2 w-2 rounded-full bg-info" />
            </span>
          }
          label="Mark as unread"
          onClick={onMarkUnread}
        />
      ) : null}
      {canSetStage ? (
        <button
          ref={stageTriggerRef}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={stageMenuOpen}
          onClick={() => {
            positionStageMenu()
            setStageMenuOpen((open) => !open)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowRight' && event.key !== 'Enter') return
            event.preventDefault()
            event.stopPropagation()
            positionStageMenu()
            setStageMenuOpen(true)
            window.requestAnimationFrame(() => {
              stageMenuRef.current
                ?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')
                ?.focus()
            })
          }}
          className="fd-focus-fill flex h-9 w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2.5 text-left text-[length:var(--fd-text-sm)] text-fg-primary hover:bg-surface-3 focus-visible:bg-surface-3"
        >
          <span aria-hidden="true" className="flex shrink-0 items-center">
            {selectedStage ? (
              <ThreadStageIcon stage={selectedStage} />
            ) : (
              <CircleDashed className={iconClassName} />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate">Set stage</span>
          <ChevronRight
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-fg-muted"
          />
        </button>
      ) : null}
      {canSetStage && stageMenuOpen ? (
        <div
          ref={stageMenuRef}
          role="menu"
          aria-label="Set stage"
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setStageMenuOpen(false)
              stageTriggerRef.current?.focus()
              return
            }
            if (
              event.key !== 'ArrowDown' &&
              event.key !== 'ArrowUp' &&
              event.key !== 'Home' &&
              event.key !== 'End'
            ) {
              return
            }
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="menuitemradio"], [role="menuitem"]',
              ),
            )
            if (items.length === 0) return
            event.preventDefault()
            event.stopPropagation()
            const currentIndex = items.indexOf(
              document.activeElement as HTMLButtonElement,
            )
            const nextIndex =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? items.length - 1
                  : event.key === 'ArrowDown'
                    ? (currentIndex + 1 + items.length) % items.length
                    : (currentIndex - 1 + items.length) % items.length
            items[nextIndex]?.focus()
          }}
          className="absolute z-10 w-[200px] overflow-y-auto rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1 shadow-[var(--fd-shadow-lg)]"
          style={{
            top: stageMenuOffsetTop,
            maxHeight: stageMenuMaxHeight ?? undefined,
            left: stageMenuSide === 'right' ? '100%' : undefined,
            right: stageMenuSide === 'left' ? '100%' : undefined,
            marginLeft: stageMenuSide === 'right' ? 4 : undefined,
            marginRight: stageMenuSide === 'left' ? 4 : undefined,
          }}
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={selectedStage == null}
            onClick={() => onSetStage(null)}
            className="fd-focus-fill flex h-8 w-full items-center gap-2.5 rounded-[var(--fd-radius-md)] px-2.5 text-left text-[length:var(--fd-text-sm)] text-fg-primary hover:bg-surface-3 focus-visible:bg-surface-3"
          >
            <CircleDashed
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-fg-muted"
            />
            <span className="min-w-0 flex-1 truncate">No stage</span>
            <Check
              aria-hidden="true"
              className={cn(
                'h-3.5 w-3.5 shrink-0',
                selectedStage == null ? 'text-fg-primary' : 'invisible',
              )}
            />
          </button>
          {stageOptions.map((stage) => {
            const selected = selectedStage?.id === stage.id
            return (
              <button
                key={stage.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => onSetStage(stage)}
                className="fd-focus-fill flex h-8 w-full items-center gap-2.5 rounded-[var(--fd-radius-md)] px-2.5 text-left text-[length:var(--fd-text-sm)] text-fg-primary hover:bg-surface-3 focus-visible:bg-surface-3"
              >
                <ThreadStageIcon stage={stage} />
                <span className="min-w-0 flex-1 truncate">{stage.label}</span>
                <Check
                  aria-hidden="true"
                  className={cn(
                    'h-3.5 w-3.5 shrink-0',
                    selected ? 'text-fg-primary' : 'invisible',
                  )}
                />
              </button>
            )
          })}
          {onCreateStage ? (
            <>
              <div
                role="separator"
                className="mx-2 my-1 border-t border-border-subtle"
              />
              <button
                type="button"
                role="menuitem"
                onClick={onCreateStage}
                className="fd-focus-fill flex h-8 w-full items-center gap-2.5 rounded-[var(--fd-radius-md)] px-2.5 text-left text-[length:var(--fd-text-sm)] text-fg-primary hover:bg-surface-3 focus-visible:bg-surface-3"
              >
                <Plus
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0 text-fg-muted"
                />
                <span className="min-w-0 flex-1 truncate">Add stage…</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {workspacePath || sessionId ? (
        <div
          role="separator"
          className="mx-2 my-1 border-t border-border-subtle"
        />
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
        <div
          role="separator"
          className="mx-2 my-1 border-t border-border-subtle"
        />
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
})

export const WorkspaceContextMenu = memo(function WorkspaceContextMenu({
  target,
  selectedColor = null,
  onSetColor,
  onRemove,
  menuRef,
}: {
  target: WorkspaceContextMenuState | null
  selectedColor?: string | null
  onSetColor?: (color: WorkspaceColorId | null) => void
  onRemove?: () => void
  menuRef: React.RefObject<HTMLDivElement | null>
}) {
  if (!target || typeof document === 'undefined') {
    return null
  }

  const projectLabel = target.path.split('/').pop() || target.path
  const showColors = Boolean(onSetColor)
  const showRemove = Boolean(onRemove)
  const menuHeight =
    THREAD_MENU_VIEWPORT_PADDING_PX * 2 +
    (showColors ? WORKSPACE_COLOR_SECTION_HEIGHT_PX : 0) +
    (showColors && showRemove ? THREAD_MENU_SEPARATOR_HEIGHT_PX : 0) +
    (showRemove ? THREAD_MENU_ROW_HEIGHT_PX : 0)
  const left = Math.max(
    THREAD_MENU_VIEWPORT_PADDING_PX,
    Math.min(
      target.x,
      window.innerWidth -
        WORKSPACE_MENU_WIDTH_PX -
        THREAD_MENU_VIEWPORT_PADDING_PX,
    ),
  )
  const top = Math.max(
    THREAD_MENU_VIEWPORT_PADDING_PX,
    Math.min(
      target.y,
      window.innerHeight - menuHeight - THREAD_MENU_VIEWPORT_PADDING_PX,
    ),
  )

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Actions for ${projectLabel}`}
      className="fixed z-50 w-56 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1 shadow-[var(--fd-shadow-lg)]"
      style={{ left, top }}
    >
      {showColors ? (
        <div className="px-1.5 pb-1 pt-1">
          <p className="mb-1.5 text-[length:var(--fd-text-xs)] text-fg-muted">
            Color
          </p>
          <div className="grid grid-cols-6 gap-1.5">
            <button
              type="button"
              role="menuitemradio"
              aria-label="Default"
              aria-checked={!selectedColor}
              onClick={() => onSetColor?.(null)}
              className={cn(
                'fd-focus flex h-[22px] w-[22px] items-center justify-center rounded-full border border-border-default',
                !selectedColor
                  ? 'ring-1 ring-fg-secondary ring-offset-1 ring-offset-surface-1'
                  : 'hover:border-border-emphasis',
              )}
            >
              <span className="h-2 w-2 rounded-full bg-fg-muted" />
            </button>
            {WORKSPACE_COLOR_IDS.map((color, index) => {
              const selected = selectedColor === color
              return (
                <button
                  key={color}
                  type="button"
                  role="menuitemradio"
                  aria-label={`Color ${index + 1}`}
                  aria-checked={selected}
                  onClick={() => onSetColor?.(color)}
                  className={cn(
                    'fd-focus h-[22px] w-[22px] rounded-full',
                    selected
                      ? 'ring-1 ring-fg-secondary ring-offset-1 ring-offset-surface-1'
                      : 'hover:opacity-90',
                  )}
                  style={{ backgroundColor: workspaceColorCssVar(color) }}
                />
              )
            })}
          </div>
        </div>
      ) : null}
      {showColors && showRemove ? (
        <div
          role="separator"
          className="mx-2 my-1 border-t border-border-subtle"
        />
      ) : null}
      {showRemove && onRemove ? (
        <ThreadMenuItem
          icon={<Trash2 className="h-3.5 w-3.5" />}
          label="Remove project"
          destructive
          onClick={onRemove}
        />
      ) : null}
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
          <p
            className="truncate text-[length:var(--fd-text-sm)] text-fg-muted"
            title={target.path}
          >
            {target.path}
          </p>
        </div>

        <p className="mt-4 text-[length:var(--fd-text-sm)] text-fg-secondary">
          Threads stay in the provider&rsquo;s own history; re-add the folder to
          restore them.
        </p>
        {error ? (
          <p className="mt-2 text-[length:var(--fd-text-xs)] text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          {/* Focus lands on the non-destructive action: these dialogs open from
              a context menu that unmounts on the same tick, so without this
              focus falls to <body> behind the overlay. */}
          <Button
            type="button"
            variant="ghost"
            autoFocus
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={onConfirm}
            aria-busy={pending}
            disabled={pending}
          >
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
            ? `This removes the thread and deletes its isolated copy at ${variant.path}. Uncommitted work there is lost; committed work stays on branch ${variant.branch}.`
            : 'This removes the thread from FalconDeck. Archiving keeps it out of the way without deleting it.'}
        </p>
        {error ? (
          <p className="mt-2 text-[length:var(--fd-text-xs)] text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          {/* Focus lands on the non-destructive action: these dialogs open from
              a context menu that unmounts on the same tick, so without this
              focus falls to <body> behind the overlay. */}
          <Button
            type="button"
            variant="ghost"
            autoFocus
            onClick={onClose}
            disabled={pending}
          >
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
  suggesting,
  onChange,
  onClose,
  onSubmit,
  onSuggestTitle,
}: {
  target: { workspaceId: string; thread: ThreadSummary } | null
  value: string
  error: string | null
  pending: boolean
  suggesting?: boolean
  onChange: (value: string) => void
  onClose: () => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
  onSuggestTitle?: () => void
}) {
  if (!target || typeof document === 'undefined') {
    return null
  }

  const busy = pending || Boolean(suggesting)

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
          <h2
            id="fd-rename-thread-title"
            className="text-[length:var(--fd-text-lg)] font-semibold text-fg-primary"
          >
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
            disabled={busy}
          />
          {onSuggestTitle ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-fg-muted hover:text-fg-secondary"
              onClick={onSuggestTitle}
              disabled={busy}
              aria-busy={suggesting}
            >
              <Sparkles className="h-3.5 w-3.5 text-accent" aria-hidden />
              {suggesting ? 'Suggesting…' : 'Suggest title'}
            </Button>
          ) : null}
          {error ? (
            <p className="text-[length:var(--fd-text-xs)] text-danger">
              {error}
            </p>
          ) : null}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          {/* No autoFocus here: the title field above already claims it. */}
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!value.trim() || busy} aria-busy={pending}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  )
})

export const AddThreadStageDialog = memo(function AddThreadStageDialog({
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
        aria-labelledby="fd-add-stage-title"
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 p-5 shadow-[var(--fd-shadow-lg)]"
      >
        <div className="space-y-1">
          <h2
            id="fd-add-stage-title"
            className="text-[length:var(--fd-text-lg)] font-semibold text-fg-primary"
          >
            Add stage
          </h2>
          <p className="truncate text-[length:var(--fd-text-sm)] text-fg-muted">
            {target.thread.title || 'New thread'}
          </p>
        </div>

        <div className="mt-4 space-y-2">
          <Input
            aria-label="Stage name"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            autoFocus
            placeholder="Blocked"
            disabled={pending}
          />
          {error ? (
            <p className="text-[length:var(--fd-text-xs)] text-danger">
              {error}
            </p>
          ) : null}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!value.trim()} aria-busy={pending}>
            {pending ? 'Adding…' : 'Add'}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  )
})
