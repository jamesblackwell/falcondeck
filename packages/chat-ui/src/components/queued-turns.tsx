import * as Popover from '@radix-ui/react-popover'
import { Clock, CornerUpRight, MoreHorizontal, Paperclip, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import type { QueuedTurnSummary } from '@falcondeck/client-core'
import { cn } from '@falcondeck/ui'

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
        'fd-focus-inset flex h-9 w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2.5 text-left text-[length:var(--fd-text-sm)]',
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

function QueuedTurnChip({
  queued,
  canSteer,
  steerDisabledReason,
  onRemove,
  onSteer,
}: {
  queued: QueuedTurnSummary
  canSteer: boolean
  steerDisabledReason: string
  onRemove: () => void
  onSteer: () => void
}) {
  const [open, setOpen] = useState(false)
  const label = queued.preview || 'Queued message'
  const iconClassName = 'h-3.5 w-3.5 text-fg-muted'

  return (
    <div className="flex items-center gap-2 self-end rounded-[var(--fd-radius-lg)] border border-dashed border-border-emphasis bg-surface-2 py-1.5 pl-3 pr-1.5">
      <Clock aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
      <span className="max-w-md truncate text-[length:var(--fd-text-sm)] text-fg-secondary">
        {label}
      </span>
      {queued.attachment_count ? (
        <span className="flex items-center gap-0.5 text-[length:var(--fd-text-xs)] text-fg-muted">
          <Paperclip aria-hidden="true" className="h-3 w-3" />
          {queued.attachment_count}
        </span>
      ) : null}
      <span className="text-[length:var(--fd-text-xs)] text-fg-muted">queued</span>
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
            <QueuedMenuItem
              icon={<CornerUpRight className={iconClassName} />}
              label="Steer instead"
              disabled={!canSteer}
              title={canSteer ? undefined : steerDisabledReason}
              onClick={() => {
                setOpen(false)
                onSteer()
              }}
            />
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
 * the agent finishes, with an overflow menu to send one now ("Steer instead")
 * or drop it.
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
}: {
  queuedTurns: QueuedTurnSummary[]
  canSteer?: boolean
  steerDisabledReason?: string
  onRemove: (queuedId: string) => void
  onSteer: (queuedId: string) => void
}) {
  if (queuedTurns.length === 0) return null
  return (
    // Same centered column as the conversation and the composer, so the chips
    // sit directly above the prompt input instead of hugging the window edge.
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5 px-3 pb-2 md:px-6">
      {queuedTurns.map((queued) => (
        <QueuedTurnChip
          key={queued.id}
          queued={queued}
          canSteer={canSteer}
          steerDisabledReason={steerDisabledReason}
          onRemove={() => onRemove(queued.id)}
          onSteer={() => onSteer(queued.id)}
        />
      ))}
    </div>
  )
}
