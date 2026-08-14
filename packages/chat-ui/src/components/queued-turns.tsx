import * as Popover from '@radix-ui/react-popover'
import { CornerDownRight, MoreHorizontal, Paperclip, Pencil, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'

import type { QueuedTurnSummary } from '@falcondeck/client-core'
import { cn } from '@falcondeck/ui'

import { isComposingKeyboardEvent } from '../lib/keyboard'

function QueuedMenuItem({
  icon,
  label,
  destructive = false,
  disabled = false,
  title,
  onClick,
}: {
  icon: ReactNode
  label: string
  destructive?: boolean
  disabled?: boolean
  title?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      aria-disabled={disabled || undefined}
      title={title}
      onClick={onClick}
      className={cn(
        'fd-focus-fill flex h-9 w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2.5 text-left text-[length:var(--fd-text-sm)]',
        disabled
          ? 'cursor-not-allowed text-fg-muted opacity-60'
          : destructive
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

function QueuedTurnEditor({
  initialText,
  onCancel,
  onSave,
}: {
  initialText: string
  onCancel: () => void
  onSave: (text: string) => void
}) {
  const [draft, setDraft] = useState(initialText)
  const commit = () => {
    const text = draft.trim()
    if (!text) return
    onSave(text)
  }

  return (
    <div className="flex w-full flex-col gap-2 rounded-[var(--fd-radius-lg)] border border-dashed border-border-emphasis bg-surface-2 p-2">
      <textarea
        autoFocus
        value={draft}
        aria-label="Edit queued message"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (isComposingKeyboardEvent(event)) return
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            commit()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
        rows={Math.min(6, Math.max(2, draft.split('\n').length))}
        className="fd-focus-inset w-full resize-none rounded-[var(--fd-radius-md)] bg-surface-1 px-2.5 py-2 text-[length:var(--fd-text-sm)] text-fg-primary"
      />
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="fd-focus-inset rounded-[var(--fd-radius-md)] px-2.5 py-1 text-[length:var(--fd-text-xs)] text-fg-muted hover:bg-surface-3 hover:text-fg-primary"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={commit}
          disabled={!draft.trim()}
          className="fd-focus-inset rounded-[var(--fd-radius-md)] bg-accent px-2.5 py-1 text-[length:var(--fd-text-xs)] font-medium text-surface-0 hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  )
}

function QueuedTurnChip({
  queued,
  canSteer,
  steerDisabledReason,
  onRemove,
  onSteer,
  onEdit,
  getAttachmentPreviewUrl,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  queued: QueuedTurnSummary
  canSteer: boolean
  steerDisabledReason: string
  onRemove: () => void
  onSteer: () => void
  onEdit?: (text: string) => void
  getAttachmentPreviewUrl?: (queuedId: string) => string | undefined | Promise<string | undefined>
  draggable: boolean
  onDragStart: (event: DragEvent<HTMLDivElement>) => void
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
}) {
  const [open, setOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const label = queued.preview || 'Queued message'
  const iconClassName = 'h-3.5 w-3.5 text-fg-muted'

  const hasAttachment = Boolean(queued.attachment_count)
  const [attachmentPreviewUrl, setAttachmentPreviewUrl] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!hasAttachment || !getAttachmentPreviewUrl) {
      setAttachmentPreviewUrl(undefined)
      return
    }
    let active = true
    Promise.resolve(getAttachmentPreviewUrl(queued.id))
      .then((url) => {
        if (active) setAttachmentPreviewUrl(url)
      })
      .catch(() => {
        if (active) setAttachmentPreviewUrl(undefined)
      })
    return () => {
      active = false
    }
  }, [getAttachmentPreviewUrl, hasAttachment, queued.id])

  if (isEditing && onEdit) {
    return (
      <QueuedTurnEditor
        // The summary's full text, not the 140-char preview — saving a
        // preview-truncated draft would chop long messages.
        initialText={queued.text ?? queued.preview}
        onCancel={() => setIsEditing(false)}
        onSave={(text) => {
          setIsEditing(false)
          onEdit(text)
        }}
      />
    )
  }

  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      data-queued-turn-id={queued.id}
      className="group flex min-h-10 cursor-grab items-center gap-2 px-2 py-1.5 active:cursor-grabbing"
    >
      <CornerDownRight aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-muted" />
      {attachmentPreviewUrl ? (
        <img
          src={attachmentPreviewUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-8 w-8 shrink-0 rounded-[var(--fd-radius-sm)] border border-border-default bg-surface-3 object-cover"
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
        {label}
      </span>
      {queued.attachment_count ? (
        <span className="flex items-center gap-0.5 text-[length:var(--fd-text-xs)] text-fg-muted">
          <Paperclip aria-hidden="true" className="h-3 w-3" />
          {queued.attachment_count}
        </span>
      ) : null}
      <button
        type="button"
        disabled={!canSteer}
        aria-disabled={!canSteer || undefined}
        title={canSteer ? undefined : steerDisabledReason}
        onClick={onSteer}
        className="fd-focus-inset flex shrink-0 items-center gap-1 rounded-[var(--fd-radius-sm)] px-1.5 py-1 text-[length:var(--fd-text-sm)] text-fg-secondary transition-colors hover:bg-interactive-hover hover:text-fg-primary disabled:cursor-not-allowed disabled:text-fg-muted disabled:opacity-60"
      >
        <CornerDownRight aria-hidden="true" className="h-3.5 w-3.5" /> Steer
      </button>
      <button
        type="button"
        aria-label={`Remove queued message: ${label}`}
        title="Remove queued message"
        onClick={onRemove}
        className="fd-focus-inset shrink-0 rounded-[var(--fd-radius-sm)] p-1.5 text-fg-muted transition-colors hover:bg-danger-muted hover:text-danger"
      >
        <Trash2 aria-hidden="true" className="h-4 w-4" />
      </button>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          type="button"
          aria-label={`Actions for queued message: ${label}`}
          aria-haspopup="menu"
          className="fd-focus-inset rounded-[var(--fd-radius-sm)] p-1 text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-primary"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Popover.Trigger>
        <Popover.Portal>
          {/* Opens upward: the chip sits directly above the composer, so a
              downward menu would render off the bottom of the pane. */}
          <Popover.Content
            role="menu"
            side="top"
            align="end"
            sideOffset={6}
            aria-label={`Actions for queued message: ${label}`}
            className="z-50 w-52 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1 shadow-[var(--fd-shadow-lg)]"
          >
            {onEdit ? (
              <QueuedMenuItem
                icon={<Pencil className={iconClassName} />}
                label="Edit message"
                onClick={() => {
                  setOpen(false)
                  setIsEditing(true)
                }}
              />
            ) : null}
            <QueuedMenuItem
              icon={<Trash2 className="h-3.5 w-3.5" />}
              label="Remove"
              destructive
              onClick={() => {
                setOpen(false)
                onRemove()
              }}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}

/**
 * Chips for turns queued behind the active one. Rendered between the
 * conversation and the composer so the user sees exactly what will fire when
 * the agent finishes, with a direct action to steer it into the active turn
 * and an overflow menu to edit or remove it.
 *
 * `canSteer` is the active provider's `supports_steering`, passed in rather
 * than derived here — this component never learns which providers can steer.
 */
export function QueuedTurns({
  queuedTurns,
  canSteer = false,
  steerDisabledReason = 'This agent cannot take a message mid-turn.',
  onRemove,
  onSteer,
  onEdit,
  onReorder,
  getAttachmentPreviewUrl,
}: {
  queuedTurns: QueuedTurnSummary[]
  canSteer?: boolean
  steerDisabledReason?: string
  onRemove: (queuedId: string) => void
  onSteer: (queuedId: string) => void
  onEdit?: (queuedId: string, text: string) => void
  onReorder?: (queuedIds: string[]) => void
  getAttachmentPreviewUrl?: (queuedId: string) => string | undefined | Promise<string | undefined>
}) {
  const draggedIdRef = useRef<string | null>(null)
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null)
  const previewOrderRef = useRef<string[] | null>(null)
  const queuedById = useMemo(
    () => new Map(queuedTurns.map((queued) => [queued.id, queued])),
    [queuedTurns],
  )
  const orderedTurns = useMemo(() => {
    if (!previewOrder) return queuedTurns
    const seen = new Set<string>()
    return [...previewOrder, ...queuedTurns.map((queued) => queued.id)].flatMap((id) => {
      if (seen.has(id)) return []
      seen.add(id)
      const queued = queuedById.get(id)
      return queued ? [queued] : []
    })
  }, [previewOrder, queuedById, queuedTurns])
  if (queuedTurns.length === 0) return null
  return (
    // Mirror the composer wrapper and its padding so this card's edges align
    // with the prompt card, at every responsive breakpoint.
    <div className="mx-auto mb-2 w-full max-w-3xl px-3 md:px-6">
      <div
        aria-label="Queued messages"
        className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-2 shadow-[var(--fd-shadow-sm)]"
      >
        {orderedTurns.map((queued) => (
          <QueuedTurnChip
            key={queued.id}
            queued={queued}
            canSteer={canSteer}
            steerDisabledReason={steerDisabledReason}
            onRemove={() => onRemove(queued.id)}
            onSteer={() => onSteer(queued.id)}
            onEdit={onEdit ? (text) => onEdit(queued.id, text) : undefined}
            getAttachmentPreviewUrl={getAttachmentPreviewUrl}
            draggable={queuedTurns.length > 1 && Boolean(onReorder)}
            onDragStart={(event) => {
              draggedIdRef.current = queued.id
              const initialOrder = orderedTurns.map((item) => item.id)
              previewOrderRef.current = initialOrder
              setPreviewOrder(initialOrder)
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', queued.id)
            }}
            onDragOver={(event) => {
              const activeDraggedId = draggedIdRef.current
              if (!activeDraggedId || activeDraggedId === queued.id) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              const order = previewOrderRef.current ?? queuedTurns.map((item) => item.id)
              const targetIndex = order.indexOf(queued.id)
              const next = order.filter((id) => id !== activeDraggedId)
              next.splice(targetIndex < 0 ? next.length : targetIndex, 0, activeDraggedId)
              previewOrderRef.current = next
              setPreviewOrder(next)
            }}
            onDragEnd={() => {
              draggedIdRef.current = null
              previewOrderRef.current = null
              setPreviewOrder(null)
            }}
            onDrop={(event) => {
              event.preventDefault()
              const next = previewOrderRef.current
              previewOrderRef.current = null
              draggedIdRef.current = null
              setPreviewOrder(null)
              if (next && next.join('\0') !== queuedTurns.map((item) => item.id).join('\0')) {
                onReorder?.(next)
              }
            }}
          />
        ))}
      </div>
    </div>
  )
}
