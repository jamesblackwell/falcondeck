import { Clock, Paperclip, X } from 'lucide-react'

import type { QueuedTurnSummary } from '@falcondeck/client-core'

/**
 * Removable chips for turns queued behind the active one. Rendered between
 * the conversation and the composer so the user sees exactly what will fire
 * when the agent finishes.
 */
export function QueuedTurns({
  queuedTurns,
  onRemove,
}: {
  queuedTurns: QueuedTurnSummary[]
  onRemove: (queuedId: string) => void
}) {
  if (queuedTurns.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5 px-1 pb-2">
      {queuedTurns.map((queued) => (
        <div
          key={queued.id}
          className="flex items-center gap-2 self-end rounded-[var(--fd-radius-lg)] border border-dashed border-border-emphasis bg-surface-2 py-1.5 pl-3 pr-1.5"
        >
          <Clock aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
          <span className="max-w-md truncate text-[length:var(--fd-text-sm)] text-fg-secondary">
            {queued.preview || 'Queued message'}
          </span>
          {queued.attachment_count ? (
            <span className="flex items-center gap-0.5 text-[length:var(--fd-text-xs)] text-fg-muted">
              <Paperclip aria-hidden="true" className="h-3 w-3" />
              {queued.attachment_count}
            </span>
          ) : null}
          <span className="text-[length:var(--fd-text-xs)] text-fg-muted">queued</span>
          <button
            type="button"
            aria-label="Remove queued message"
            onClick={() => onRemove(queued.id)}
            className="rounded-[var(--fd-radius-sm)] p-1 text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-primary"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
