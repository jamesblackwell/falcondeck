import { memo, useMemo } from 'react'
import { Archive, LoaderCircle } from 'lucide-react'

import { deriveThreadAttentionPresentation, type ThreadSummary } from '@falcondeck/client-core'
import { Badge, cn } from '@falcondeck/ui'

export type ThreadItemProps = {
  thread: ThreadSummary
  workspaceId: string
  isSelected: boolean
  onSelect: (workspaceId: string, threadId: string) => void
  onArchive?: (workspaceId: string, threadId: string) => void
  nowTick?: number
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
  function ThreadItem({
    thread,
    workspaceId,
    isSelected,
    onSelect,
    onArchive,
    nowTick = 0,
  }: ThreadItemProps) {
    const attention = deriveThreadAttentionPresentation(thread)
    const timeString = useMemo(() => timeAgo(thread.updated_at), [nowTick, thread.updated_at])

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
          onClick={() => onSelect(workspaceId, thread.id)}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            {attention.showSpinner ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin text-accent" />
            ) : attention.level === 'error' ? (
              <span className="h-2.5 w-2.5 rounded-full bg-danger" />
            ) : attention.level === 'awaiting_response' ? (
              <span className="h-2.5 w-2.5 rounded-full bg-warning shadow-[0_0_0_3px_var(--fd-color-warning-muted)]" />
            ) : attention.showUnreadDot ? (
              <span className="h-2.5 w-2.5 rounded-full bg-info" />
            ) : (
              <span className="h-3 w-3 rounded-full border border-fg-faint" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-[length:var(--fd-text-base)] text-fg-primary">
            {thread.title}
          </span>
        </button>
        {attention.showBadge ? (
          <Badge variant="success" className="shrink-0 bg-success/15 text-success">
            {attention.badgeLabel}
          </Badge>
        ) : (
          <span className="shrink-0 text-[length:var(--fd-text-sm)] text-fg-faint group-hover:hidden">
            {timeString}
          </span>
        )}
        {onArchive ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onArchive(workspaceId, thread.id)
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
    prev.workspaceId === next.workspaceId &&
    prev.isSelected === next.isSelected &&
    prev.nowTick === next.nowTick &&
    prev.onSelect === next.onSelect &&
    prev.onArchive === next.onArchive,
)
