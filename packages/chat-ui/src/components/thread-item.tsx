import { memo, useMemo } from 'react'
import { LoaderCircle } from 'lucide-react'

import type { ThreadSummary } from '@falcondeck/client-core'
import { cn } from '@falcondeck/ui'

export type ThreadItemProps = {
  thread: ThreadSummary
  isSelected: boolean
  onSelect: () => void
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

export const ThreadItem = memo(function ThreadItem({ thread, isSelected, onSelect }: ThreadItemProps) {
  const isRunning = thread.status === 'running'
  const timeString = useMemo(() => timeAgo(thread.updated_at), [thread.updated_at])

  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center gap-1.5 overflow-hidden rounded-[var(--fd-radius-md)] px-2 py-1.5 text-left transition-colors duration-[var(--fd-duration-fast)]',
        isSelected
          ? 'bg-accent-dim'
          : 'hover:bg-surface-3',
      )}
      onClick={onSelect}
    >
      {isRunning ? (
        <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
      ) : null}
      <span className="min-w-0 flex-1 truncate text-[length:var(--fd-text-sm)] text-fg-primary">
        {thread.title}
      </span>
      <span className="shrink-0 text-[length:var(--fd-text-xs)] text-fg-faint">
        {timeString}
      </span>
    </button>
  )
})
