import * as React from 'react'
import { memo, useMemo } from 'react'
import { Archive, CalendarClock, CircleStop, Pin, Split } from 'lucide-react'

import {
  deriveThreadAttentionPresentation,
  wasTurnInterruptedByShutdown,
  type ThreadSummary,
  type ThreadTag,
} from '@falcondeck/client-core'
import { ActivityDiamond, Badge, cn } from '@falcondeck/ui'

import { ThreadStageIcon } from './thread-stage-icon'

export type ThreadItemArchiveHandler = (
  workspaceId: string,
  threadId: string,
) => Promise<void> | void

export type ThreadItemProps = {
  thread: ThreadSummary
  workspaceId: string
  isSelected: boolean
  onSelect: (workspaceId: string, threadId: string) => void
  onArchive?: ThreadItemArchiveHandler
  onOpenContextMenu?: (args: {
    workspaceId: string
    thread: ThreadSummary
    x: number
    y: number
  }) => void
  onRequestRename?: (args: {
    workspaceId: string
    thread: ThreadSummary
  }) => void
  nowTick?: number
  tags?: ThreadTag[]
  /** Provider the thread runs on; revealed on hover when the row has room. */
  providerLabel?: string | null
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
    onOpenContextMenu,
    onRequestRename,
    nowTick = 0,
    tags = [],
    providerLabel = null,
  }: ThreadItemProps) {
    const attention = deriveThreadAttentionPresentation(thread)
    const wasInterrupted = wasTurnInterruptedByShutdown(thread)
    const timeString = useMemo(
      () => timeAgo(thread.updated_at),
      [nowTick, thread.updated_at],
    )

    return (
      <div
        className={cn(
          // A container so the provider label can bow out on a narrow sidebar
          // without the row measuring itself in JS.
          '@container group flex w-full items-center gap-2 overflow-hidden rounded-[var(--fd-radius-md)] px-2.5 py-2',
          'transition-colors duration-[var(--fd-duration-fast)]',
          // Pressing previews the selection fill rather than a brighter tone of
          // its own. A hotter pressed state overshoots the colour the row is
          // about to land on, so the click read as a white flash followed by a
          // snap back down. Press and release now paint the same fill, and the
          // crossfade lets the outgoing row hand the highlight over.
          isSelected
            ? 'fd-row-selected'
            : 'hover:bg-interactive-hover active:bg-interactive-selected',
        )}
        onClick={() => onSelect(workspaceId, thread.id)}
        onContextMenu={(event: React.MouseEvent<HTMLDivElement>) => {
          if (!onOpenContextMenu) return
          event.preventDefault()
          onOpenContextMenu({
            workspaceId,
            thread,
            x: event.clientX,
            y: event.clientY,
          })
        }}
        onDoubleClick={(event: React.MouseEvent<HTMLDivElement>) => {
          if (!onRequestRename) return
          event.preventDefault()
          onRequestRename({ workspaceId, thread })
        }}
      >
        <button
          type="button"
          className="fd-focus-inset flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--fd-radius-sm)] text-left"
          onClick={(event) => {
            // Selection also lives on the full row so the timestamp and
            // trailing space match the hover/selected hit area. Keep the
            // title button from selecting twice as the click bubbles up.
            event.stopPropagation()
            onSelect(workspaceId, thread.id)
          }}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            {wasInterrupted ? (
              <CircleStop
                role="img"
                aria-label="Stopped when FalconDeck closed"
                className="h-3.5 w-3.5 text-danger"
              />
            ) : attention.showSpinner ? (
              <ActivityDiamond />
            ) : attention.level === 'error' ? (
              <span className="h-2.5 w-2.5 rounded-full bg-danger" />
            ) : attention.level === 'awaiting_response' ? (
              <span className="h-2.5 w-2.5 rounded-full bg-warning shadow-[0_0_0_3px_var(--fd-warning-muted)]" />
            ) : attention.showUnreadDot ? (
              <span className="h-2.5 w-2.5 rounded-full bg-info" />
            ) : null}
          </span>
          <span
            className={cn(
              "fd-type-supporting min-w-0 flex-1 truncate transition-colors duration-[var(--fd-duration-fast)]",
              isSelected
                ? "text-fg-primary"
                : "text-fg-secondary group-hover:text-fg-primary",
            )}
          >
            {thread.title}
          </span>
          {thread.origin?.kind === 'scheduled_task' ? (
            <span
              role="img"
              aria-label={`Scheduled task: ${thread.origin.title}`}
              title={`Scheduled · ${thread.origin.title}`}
              className="flex shrink-0 items-center text-fg-muted"
            >
              <CalendarClock aria-hidden="true" className="h-3 w-3" />
            </span>
          ) : thread.origin?.kind === 'automation' ? (
            <span
              role="img"
              aria-label={`Automation: ${thread.origin.name}`}
              title={`Automation · ${thread.origin.name}`}
              className="flex shrink-0 items-center text-fg-muted"
            >
              <CalendarClock aria-hidden="true" className="h-3 w-3" />
            </span>
          ) : null}
          {tags.length > 0 ? (
            <span className="flex shrink-0 items-center gap-1" aria-label={tags.map(tag => tag.label).join(', ')}>
              {tags.slice(0, 1).map(tag => (
                <span key={tag.id} title={tag.label} className="flex items-center">
                  <ThreadStageIcon stage={tag} />
                </span>
              ))}
            </span>
          ) : null}
          {thread.variant ? (
            // The same Split icon the composer uses for "Isolated copy", so
            // the sidebar marker reads as that choice rather than git detail.
            <span
              role="img"
              aria-label="Isolated copy"
              title={`Isolated copy — changes land on branch ${thread.variant.branch}, not in your project folder`}
              className="flex shrink-0 items-center text-fg-muted"
            >
              <Split aria-hidden="true" className="h-3 w-3" />
            </span>
          ) : null}
          {thread.is_pinned ? (
            <Pin
              role="img"
              aria-label="Pinned"
              className="h-3 w-3 shrink-0 rotate-45 text-fg-muted"
            />
          ) : null}
        </button>
        {providerLabel ? (
          // Takes over the space the timestamp vacates on hover, and only once
          // the row is wide enough that the title is not paying for it.
          <span
            data-testid="thread-provider-label"
            className="fd-type-meta hidden max-w-[45%] shrink-0 truncate text-fg-muted @[15rem]:group-hover:block"
          >
            {providerLabel}
          </span>
        ) : null}
        {wasInterrupted ? (
          <Badge variant="danger" className="shrink-0">
            Stopped
          </Badge>
        ) : attention.showBadge ? (
          <Badge variant="success" className="shrink-0">
            {attention.badgeLabel}
          </Badge>
        ) : (
          <span className="fd-type-meta shrink-0 text-fg-muted group-hover:hidden">
            {timeString}
          </span>
        )}
        {onArchive ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              void Promise.resolve(onArchive(workspaceId, thread.id)).catch(
                () => {},
              )
            }}
            title="Archive thread"
            aria-label={`Archive thread ${thread.title}`}
            className="fd-focus hidden shrink-0 rounded-[var(--fd-radius-sm)] p-0.5 text-fg-muted hover:text-fg-secondary focus-visible:block group-hover:block"
          >
            <Archive aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    )
  },
  (prev, next) =>
    // Snapshot refreshes recreate every thread object, so identity comparison
    // would re-render the whole sidebar on each message. Compare the fields
    // this row actually renders instead.
    threadRenderEqual(prev.thread, next.thread) &&
    prev.workspaceId === next.workspaceId &&
    prev.isSelected === next.isSelected &&
    prev.providerLabel === next.providerLabel &&
    prev.nowTick === next.nowTick &&
    prev.onSelect === next.onSelect &&
    prev.onArchive === next.onArchive &&
    prev.onOpenContextMenu === next.onOpenContextMenu &&
    prev.onRequestRename === next.onRequestRename &&
    tagsEqual(prev.tags, next.tags),
)

function tagsEqual(a: ThreadTag[] | undefined, b: ThreadTag[] | undefined) {
  if (a === b) return true
  if ((a?.length ?? 0) !== (b?.length ?? 0)) return false
  return (a ?? []).every((tag, index) => {
    const other = b?.[index]
    return (
      tag.id === other?.id &&
      tag.label === other.label &&
      tag.color === other.color &&
      tag.icon === other.icon
    )
  })
}

function originEqual(a: ThreadSummary['origin'], b: ThreadSummary['origin']) {
  if (a === b) return true
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === 'scheduled_task' && b.kind === 'scheduled_task') {
    return a.task_id === b.task_id && a.title === b.title
  }
  if (a.kind === 'automation' && b.kind === 'automation') {
    return a.automation_id === b.automation_id && a.name === b.name
  }
  return true
}

function threadRenderEqual(a: ThreadSummary, b: ThreadSummary) {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.updated_at === b.updated_at &&
    a.status === b.status &&
    a.last_error === b.last_error &&
    a.is_pinned === b.is_pinned &&
    a.variant?.slug === b.variant?.slug &&
    originEqual(a.origin, b.origin) &&
    a.attention.unread === b.attention.unread &&
    a.attention.badge_label === b.attention.badge_label &&
    a.attention.pending_approval_count === b.attention.pending_approval_count &&
    a.attention.pending_question_count === b.attention.pending_question_count &&
    a.attention.last_agent_activity_seq ===
      b.attention.last_agent_activity_seq &&
    a.attention.last_read_seq === b.attention.last_read_seq
  )
}
