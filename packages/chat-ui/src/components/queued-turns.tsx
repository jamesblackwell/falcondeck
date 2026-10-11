import * as Popover from '@radix-ui/react-popover'
import { CornerDownRight, MoreHorizontal, Paperclip, Pencil, Trash2 } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

import type { QueuedTurnSummary } from '@falcondeck/client-core'
import { cn } from '@falcondeck/ui'

import { isComposingKeyboardEvent } from '../lib/keyboard'

const QUEUED_DRAG_THRESHOLD_PX = 4
const QUEUED_DRAG_INTERACTIVE = 'button, a, input, textarea, select, [data-no-queued-drag]'

type QueuedDrag = {
  pointerId: number
  id: string
  startX: number
  startY: number
  active: boolean
  /** Displayed order when the pointer went down. Escape restores this. */
  originOrder: string[]
  element: HTMLDivElement
}

function sameQueuedOrder(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/** True once the server's queue lists these ids in the preview's relative order.
    A message that arrived or left while the request was in flight does not
    count as a mismatch. */
function queuedOrderCaughtUp(serverIds: readonly string[], previewIds: readonly string[]) {
  const previewSet = new Set(previewIds)
  const serverKept = serverIds.filter((id) => previewSet.has(id))
  const previewKept = previewIds.filter((id) => serverIds.includes(id))
  return sameQueuedOrder(serverKept, previewKept)
}

/** Inserts the dragged id around the other rows by pointer Y. The dragged row
    stays in the layout, so only the other rows' midpoints are tested. */
function orderForQueuedPointer(
  order: readonly string[],
  draggedId: string,
  clientY: number,
  rows: ReadonlyMap<string, HTMLElement>,
) {
  const others = order.filter((id) => id !== draggedId)
  let index = others.length
  for (let position = 0; position < others.length; position += 1) {
    const row = rows.get(others[position]!)
    if (!row) continue
    const rect = row.getBoundingClientRect()
    if (clientY < rect.top + rect.height / 2) {
      index = position
      break
    }
  }
  const next = others.slice()
  next.splice(index, 0, draggedId)
  return next
}

/** Preferred order, limited to ids still queued, with new ids after them. */
function visibleQueuedOrder(preferred: readonly string[], serverIds: readonly string[]) {
  const serverSet = new Set(serverIds)
  const seen = new Set<string>()
  const next: string[] = []
  for (const id of preferred) {
    if (!serverSet.has(id) || seen.has(id)) continue
    seen.add(id)
    next.push(id)
  }
  for (const id of serverIds) {
    if (seen.has(id)) continue
    seen.add(id)
    next.push(id)
  }
  return next
}

/** True when this gesture changed the relative order of messages that were
    queued when it started and are still queued now. */
function gestureReordered(
  origin: readonly string[],
  next: readonly string[],
  serverIds: readonly string[],
) {
  const stillQueued = new Set(serverIds)
  const originKept = origin.filter((id) => stillQueued.has(id))
  const originIds = new Set(origin)
  const nextKept = next.filter((id) => originIds.has(id))
  return !sameQueuedOrder(originKept, nextKept)
}

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
  isDragging,
  registerRow,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onClickCapture,
}: {
  queued: QueuedTurnSummary
  canSteer: boolean
  steerDisabledReason: string
  onRemove: () => void
  onSteer: () => void
  onEdit?: (text: string) => void
  getAttachmentPreviewUrl?: (queuedId: string) => string | undefined | Promise<string | undefined>
  draggable: boolean
  isDragging: boolean
  registerRow: (id: string, node: HTMLDivElement | null) => void
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void
  onClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => void
}) {
  const [open, setOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const label = queued.preview || 'Queued message'
  // Stable across renders so a drag's setState does not detach every row.
  const rowRef = useCallback(
    (node: HTMLDivElement | null) => registerRow(queued.id, node),
    [queued.id, registerRow],
  )
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

  const editing = Boolean(isEditing && onEdit)
  // The editor stays inside this row so a drag of another message still
  // measures it. Replacing the row would drop it from hit testing.
  const handleDrag = draggable && !editing

  return (
    <div
      ref={rowRef}
      onPointerDown={handleDrag ? onPointerDown : undefined}
      onPointerMove={handleDrag ? onPointerMove : undefined}
      onPointerUp={handleDrag ? onPointerUp : undefined}
      onPointerCancel={handleDrag ? onPointerCancel : undefined}
      onClickCapture={handleDrag ? onClickCapture : undefined}
      onDragStart={(event) => event.preventDefault()}
      data-queued-turn-id={queued.id}
      aria-grabbed={isDragging ? true : undefined}
      style={handleDrag ? { touchAction: 'none' } : undefined}
      className={cn(
        'group min-h-10',
        editing ? null : 'flex items-center gap-2 px-2 py-1.5',
        handleDrag && 'cursor-grab select-none',
        isDragging && 'relative z-10 cursor-grabbing bg-surface-3',
      )}
    >
      {editing && onEdit ? (
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
      ) : (
        <>
          <span title={draggable ? 'Drag to reorder' : undefined} className="flex shrink-0">
            <CornerDownRight aria-hidden="true" className="h-4 w-4 text-fg-muted" />
          </span>
          {attachmentPreviewUrl ? (
            <img
              src={attachmentPreviewUrl}
              alt=""
              draggable={false}
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
            className="fd-focus-inset flex shrink-0 cursor-pointer items-center gap-1 rounded-[var(--fd-radius-sm)] px-1.5 py-1 text-[length:var(--fd-text-sm)] text-fg-secondary transition-colors hover:bg-interactive-hover hover:text-fg-primary disabled:cursor-not-allowed disabled:text-fg-muted disabled:opacity-60"
          >
            <CornerDownRight aria-hidden="true" className="h-3.5 w-3.5" /> Steer
          </button>
          <button
            type="button"
            aria-label={`Remove queued message: ${label}`}
            title="Remove queued message"
            onClick={onRemove}
            className="fd-focus-inset shrink-0 cursor-pointer rounded-[var(--fd-radius-sm)] p-1.5 text-fg-muted transition-colors hover:bg-danger-muted hover:text-danger"
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </button>
          <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger
              type="button"
              aria-label={`Actions for queued message: ${label}`}
              aria-haspopup="menu"
              className="fd-focus-inset cursor-pointer rounded-[var(--fd-radius-sm)] p-1 text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-primary"
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
        </>
      )}
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
 *
 * Rows reorder with pointer events. Moving a node during an HTML5 drag cancels
 * the gesture before drop, including in the desktop webview.
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
  onReorder?: (queuedIds: string[]) => void | Promise<void>
  getAttachmentPreviewUrl?: (queuedId: string) => string | undefined | Promise<string | undefined>
}) {
  const dragRef = useRef<QueuedDrag | null>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const previewOrderRef = useRef<string[] | null>(null)
  const suppressClickRef = useRef(false)
  const onReorderRef = useRef(onReorder)
  const queuedIdsRef = useRef<string[]>([])
  const reorderSeqRef = useRef(0)
  const reorderPendingRef = useRef(0)
  const reorderTailRef = useRef<Promise<void>>(Promise.resolve())
  // Set when the latest save fails while a drag is active, so ending that
  // drag snaps back instead of keeping the rejected order.
  const reorderRejectedRef = useRef(false)
  // Removed when the gesture ends. A press that slips off the row before the
  // drag threshold otherwise never receives pointerup and blocks the next drag.
  const releaseWatchRef = useRef<(() => void) | null>(null)
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  onReorderRef.current = onReorder
  queuedIdsRef.current = queuedTurns.map((queued) => queued.id)
  const registerRow = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) rowRefs.current.set(id, node)
    else rowRefs.current.delete(id)
  }, [])

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
  const orderedIdsRef = useRef<string[]>([])
  orderedIdsRef.current = orderedTurns.map((queued) => queued.id)

  const clearPreview = () => {
    reorderRejectedRef.current = false
    previewOrderRef.current = null
    setPreviewOrder(null)
  }

  const settlePreview = () => {
    if (dragRef.current?.active || reorderPendingRef.current > 0) return
    const preview = previewOrderRef.current
    if (!preview) return
    if (
      queuedIdsRef.current.length < 2 ||
      queuedOrderCaughtUp(queuedIdsRef.current, preview)
    ) {
      clearPreview()
    }
  }

  const stopPointerWatch = () => {
    releaseWatchRef.current?.()
    releaseWatchRef.current = null
  }

  const releaseDrag = (drag: QueuedDrag) => {
    try {
      if (drag.element.hasPointerCapture?.(drag.pointerId)) {
        drag.element.releasePointerCapture(drag.pointerId)
      }
    } catch {
      // The row may already have unmounted.
    }
  }

  const suppressFollowingClick = () => {
    // The click that follows pointerup is a separate event. Clear the
    // suppression on the next turn so a later Steer tap still lands.
    suppressClickRef.current = true
    window.setTimeout(() => {
      suppressClickRef.current = false
    }, 0)
  }

  const restoreOrder = (order: readonly string[]) => {
    if (sameQueuedOrder(order, queuedIdsRef.current)) {
      clearPreview()
      return
    }
    const next = order.slice()
    previewOrderRef.current = next
    setPreviewOrder(next)
  }

  // Saves run one at a time. The handler and the dropped ids are captured
  // here, so a later thread change cannot retarget the request. Before the
  // request is sent, ids that arrived or left on this same queue are folded in.
  const submitReorder = (dropped: readonly string[]) => {
    const reorder = onReorderRef.current
    const requestedAtDrop = dropped.slice()
    const sequence = ++reorderSeqRef.current
    reorderRejectedRef.current = false
    const pendingBefore = reorderPendingRef.current
    reorderPendingRef.current += 1
    const run = async () => {
      try {
        if (sequence !== reorderSeqRef.current) return
        if (!reorder) throw new Error('Queue reorder is unavailable.')
        const current = queuedIdsRef.current
        const sameQueue = requestedAtDrop.some((id) => current.includes(id))
        const requested = sameQueue
          ? visibleQueuedOrder(requestedAtDrop, current)
          : requestedAtDrop
        if (requested.length < 2) return
        await reorder(requested)
      } catch {
        if (sequence !== reorderSeqRef.current) return
        // A drag in progress owns the preview. Remember the failure so
        // releasing or cancelling that drag does not keep the rejected order.
        if (dragRef.current?.active) {
          reorderRejectedRef.current = true
          return
        }
        clearPreview()
      } finally {
        reorderPendingRef.current -= 1
        if (reorderPendingRef.current === 0) settlePreview()
      }
    }
    const previous = reorderTailRef.current
    reorderTailRef.current =
      pendingBefore === 0 ? run() : previous.catch(() => undefined).then(run)
  }

  const finishDrag = (pointerId?: number) => {
    const drag = dragRef.current
    if (!drag) return
    if (pointerId != null && pointerId !== drag.pointerId) return
    stopPointerWatch()
    dragRef.current = null
    releaseDrag(drag)
    setDraggingId(null)
    if (!drag.active) return
    suppressFollowingClick()
    const next = visibleQueuedOrder(
      previewOrderRef.current ?? drag.originOrder,
      queuedIdsRef.current,
    )
    if (!gestureReordered(drag.originOrder, next, queuedIdsRef.current)) {
      if (reorderRejectedRef.current) clearPreview()
      return
    }
    previewOrderRef.current = next
    setPreviewOrder(next)
    submitReorder(next)
  }

  const cancelDrag = () => {
    const drag = dragRef.current
    if (!drag) return
    stopPointerWatch()
    dragRef.current = null
    releaseDrag(drag)
    setDraggingId(null)
    if (!drag.active) return
    suppressFollowingClick()
    if (reorderRejectedRef.current) {
      clearPreview()
      return
    }
    restoreOrder(drag.originOrder)
  }

  const moveDrag = (pointerId: number, clientX: number, clientY: number) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== pointerId) return
    const distance = Math.hypot(clientX - drag.startX, clientY - drag.startY)
    if (!drag.active && distance < QUEUED_DRAG_THRESHOLD_PX) return
    if (!drag.active) {
      drag.active = true
      const seeded = drag.originOrder.slice()
      previewOrderRef.current = seeded
      setPreviewOrder(seeded)
      setDraggingId(drag.id)
      try {
        drag.element.setPointerCapture?.(pointerId)
      } catch {
        // Window listeners follow the pointer when the row cannot capture it.
      }
    }
    const next = orderForQueuedPointer(
      previewOrderRef.current ?? drag.originOrder,
      drag.id,
      clientY,
      rowRefs.current,
    )
    if (previewOrderRef.current && sameQueuedOrder(next, previewOrderRef.current)) return
    previewOrderRef.current = next
    setPreviewOrder(next)
  }

  useEffect(() => {
    if (draggingId || reorderPendingRef.current > 0) return
    settlePreview()
  }, [draggingId, previewOrder, queuedTurns])

  useEffect(() => {
    const drag = dragRef.current
    if (!drag) return
    const draggedMissing = !queuedTurns.some((queued) => queued.id === drag.id)
    // One row left cannot be reordered, and its pointer-up handler is gone.
    if (!draggedMissing && queuedTurns.length > 1) return
    stopPointerWatch()
    dragRef.current = null
    releaseDrag(drag)
    setDraggingId(null)
    if (!drag.active) return
    if (reorderRejectedRef.current) clearPreview()
    else restoreOrder(drag.originOrder)
  }, [queuedTurns])

  useEffect(() => () => stopPointerWatch(), [])

  useEffect(() => {
    if (!draggingId) return
    const onPointerMove = (event: PointerEvent) => {
      if (dragRef.current?.pointerId !== event.pointerId) return
      event.preventDefault()
      moveDrag(event.pointerId, event.clientX, event.clientY)
    }
    const onPointerUp = (event: PointerEvent) => finishDrag(event.pointerId)
    const onPointerCancel = (event: PointerEvent) => {
      if (dragRef.current?.pointerId !== event.pointerId) return
      cancelDrag()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      cancelDrag()
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [draggingId])

  const canDrag = queuedTurns.length > 1 && Boolean(onReorder)
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
            draggable={canDrag}
            isDragging={draggingId === queued.id}
            registerRow={registerRow}
            onPointerDown={(event) => {
              if (dragRef.current || event.button !== 0 || event.isPrimary === false) return
              const target = event.target
              if (!(target instanceof Element) || target.closest(QUEUED_DRAG_INTERACTIVE)) return
              dragRef.current = {
                pointerId: event.pointerId,
                id: queued.id,
                startX: event.clientX,
                startY: event.clientY,
                active: false,
                originOrder: orderedIdsRef.current.slice(),
                element: event.currentTarget,
              }
              try {
                event.currentTarget.setPointerCapture?.(event.pointerId)
              } catch {
                // The window listener below still ends the gesture.
              }
              const pointerId = event.pointerId
              const endWatch = () => stopPointerWatch()
              const onUp = (native: PointerEvent) => {
                if (native.pointerId !== pointerId) return
                endWatch()
                finishDrag(native.pointerId)
              }
              const onCancel = (native: PointerEvent) => {
                if (native.pointerId !== pointerId) return
                endWatch()
                cancelDrag()
              }
              stopPointerWatch()
              window.addEventListener('pointerup', onUp)
              window.addEventListener('pointercancel', onCancel)
              releaseWatchRef.current = () => {
                window.removeEventListener('pointerup', onUp)
                window.removeEventListener('pointercancel', onCancel)
              }
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current
              if (!drag || drag.id !== queued.id) return
              moveDrag(event.pointerId, event.clientX, event.clientY)
            }}
            onPointerUp={(event) => finishDrag(event.pointerId)}
            onPointerCancel={(event) => {
              if (dragRef.current?.pointerId !== event.pointerId) return
              cancelDrag()
            }}
            onClickCapture={(event) => {
              if (!suppressClickRef.current) return
              suppressClickRef.current = false
              event.preventDefault()
              event.stopPropagation()
            }}
          />
        ))}
      </div>
    </div>
  )
}
