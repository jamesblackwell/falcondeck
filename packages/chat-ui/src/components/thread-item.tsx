import { memo, useMemo } from 'react'
import { Archive, LoaderCircle } from 'lucide-react'

import type { ThreadSummary } from '@falcondeck/client-core'
import { cn } from '@falcondeck/ui'

export type ThreadItemProps = {
  thread: ThreadSummary
  isSelected: boolean
  onSelect: () => void
  onArchive?: () => void
}

function timeAgo(dateStr: string) {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

export const ThreadItem = memo(
  function ThreadItem({ thread, isSelected, onSelect, onArchive }: ThreadItemProps) {
    const isRunning = thread.status === 'running'
    const timeString = useMemo(() => timeAgo(thread.updated_at), [thread.updated_at])

    return (
      <div
        className={cn(
          'group flex w-full items-center gap-2 overflow-hidden rounded-[var(--fd-radius-md)] px-2.5 py-2',
          isSelected
            ? 'bg-accent-dim'
            : 'hover:bg-surface-3 active:bg-surface-4',
        )}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={onSelect}
        >
          {isRunning ? (
            <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-[length:var(--fd-text-base)] text-fg-primary">
            {thread.title}
          </span>
        </button>
        <span className="shrink-0 text-[length:var(--fd-text-sm)] text-fg-faint group-hover:hidden">
          {timeString}
        </span>
        {onArchive ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onArchive()
            }}
            title="Archive thread"
            className="hidden shrink-0 rounded-[var(--fd-radius-sm)] p-0.5 text-fg-muted hover:text-fg-secondary group-hover:block"
          >
            <Archive className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    )
  },
  (prev, next) =>
    prev.thread === next.thread &&
    prev.isSelected === next.isSelected &&
    Boolean(prev.onArchive) === Boolean(next.onArchive),
)
