import type { ThreadSummary } from '@falcondeck/client-core'
import { cn, StatusIndicator } from '@falcondeck/ui'

export type ThreadItemProps = {
  thread: ThreadSummary
  isSelected: boolean
  onSelect: () => void
  compact?: boolean
}

function threadStatusMap(status: ThreadSummary['status']) {
  switch (status) {
    case 'running':
      return 'active' as const
    case 'waiting_for_approval':
      return 'warning' as const
    case 'error':
      return 'error' as const
    default:
      return 'idle' as const
  }
}

export function ThreadItem({ thread, isSelected, onSelect, compact }: ThreadItemProps) {
  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-start gap-2.5 rounded-[var(--fd-radius-md)] px-3 py-2 text-left transition-colors duration-[var(--fd-duration-fast)]',
        isSelected
          ? 'bg-accent-dim'
          : 'hover:bg-surface-3',
      )}
      onClick={onSelect}
    >
      <StatusIndicator
        status={threadStatusMap(thread.status)}
        size="sm"
        pulse={thread.status === 'running'}
        className="mt-1.5"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
          {thread.title}
        </p>
        {!compact && thread.last_message_preview ? (
          <p className="mt-0.5 line-clamp-1 text-[length:var(--fd-text-xs)] text-fg-muted">
            {thread.last_message_preview}
          </p>
        ) : null}
      </div>
    </button>
  )
}
