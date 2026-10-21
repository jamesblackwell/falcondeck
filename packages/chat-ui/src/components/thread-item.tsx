import { useProjectFolders } from './project-folders'
import * as React from 'react'
import { memo, useId, useMemo } from 'react'
import { Archive, ArchiveRestore, Bot, CalendarClock, CircleStop, Pin, Split } from 'lucide-react'

import {
  deriveThreadAttentionPresentation,
  wasTurnInterruptedByShutdown,
  type ThreadSummary,
  type ThreadTag,
} from '@falcondeck/client-core'
import { ActivityDiamond, Badge, cn } from '@falcondeck/ui'

import { ProviderIcon } from './provider-icon'
import { ThreadStageIcon } from './thread-stage-icon'
import { WorkspaceIcon } from './workspace-icon'

export type ThreadItemArchiveHandler = (
  workspaceId: string,
  threadId: string,
) => Promise<void> | void

/** Project glyph for a thread row that is shown outside its folder. */
export type ThreadProjectMark = {
  src: string | null
  color: string | null
  label: string
}

export type ThreadItemProps = {
  thread: ThreadSummary
  workspaceId: string
  isSelected: boolean
  onSelect: (workspaceId: string, threadId: string) => void
  /** Invoked once the archive is confirmed; the row asks first. */
  onArchive?: ThreadItemArchiveHandler
  /** Restores an archived row immediately; no confirm. */
  onUnarchive?: ThreadItemArchiveHandler
  /** Archive was requested for this row and it is waiting on the Confirm pill. */
  archiveConfirmPending?: boolean
  onArchiveConfirm?: () => void
  /** Backs out of the pending archive (dimmed row click). */
  onArchiveCancel?: () => void
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
  /** Display name for the thread's harness; labels the trailing mark. */
  providerLabel?: string | null
  /**
   * Project glyph for rows that sit outside their folder, such as the global
   * Pinned list. Casual chats have no project and omit it.
   */
  projectMark?: ThreadProjectMark | null
  /**
   * Rung in the spawn tree: 0 draws a plain row, deeper values indent and draw
   * the elbow back up to the chat that started this one.
   */
  depth?: number
  /**
   * Rungs whose upright keeps running below this row, as packed by
   * `nestSpawnedThreads`. Ancestor uprights pass straight through.
   */
  trunkMask?: number
}

/** Rung width, and where in it the connector's upright sits. */
const NESTING_RUNG_PX = 14
const NESTING_LINE_PX = 6

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

export function formatThreadTimestamp(dateStr: string, now = new Date()) {
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return undefined
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(date.getFullYear() === now.getFullYear()
      ? {}
      : { year: 'numeric' as const }),
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

export const ThreadItem = memo(
  function ThreadItem({
    thread,
    workspaceId,
    isSelected,
    onSelect,
    onArchive,
    onUnarchive,
    onOpenContextMenu,
    onRequestRename,
    nowTick = 0,
    tags = [],
    providerLabel = null,
    projectMark = null,
    archiveConfirmPending = false,
    onArchiveConfirm,
    onArchiveCancel,
    depth = 0,
    trunkMask = 0,
  }: ThreadItemProps) {
    const folderControls = useProjectFolders()
    const canDrag = Boolean(folderControls.onProjectFolderMutation && !thread.is_archived)
    const isDragged = folderControls.draggedTask?.threadId === thread.id
    const attention = deriveThreadAttentionPresentation(thread)
    const wasInterrupted = wasTurnInterruptedByShutdown(thread)
    // The project name stays outside the title button so that button's name
    // stays the thread title. Text inside the button is joined into the name.
    const projectDescriptionId = useId()
    const archiveConfirm = archiveConfirmPending && Boolean(onArchiveConfirm)
    const hoverAction = thread.is_archived
      ? onUnarchive
        ? ('unarchive' as const)
        : null
      : onArchive
        ? ('archive' as const)
        : null
    const timeString = useMemo(
      () => timeAgo(thread.updated_at),
      [nowTick, thread.updated_at],
    )
    const fullTimestamp = useMemo(
      () => formatThreadTimestamp(thread.updated_at),
      [thread.updated_at],
    )

    return (
      <div
        onPointerDown={
          canDrag
            ? (event) =>
                folderControls.startTaskDrag(
                  event,
                  { workspaceId, threadId: thread.id },
                  thread.title,
                )
            : undefined
        }
        data-archive-confirm={archiveConfirm ? "true" : undefined}
        className={cn(
          // A container so the provider label can bow out on a narrow sidebar
          // without the row measuring itself in JS.
          '@container group flex w-full items-center gap-2 overflow-hidden rounded-[var(--fd-radius-md)] px-2.5 py-2',
          'transition-colors duration-[var(--fd-duration-hover)]',
          // Pressing previews the selection fill rather than a brighter tone of
          // its own. A hotter pressed state overshoots the colour the row is
          // about to land on, so the click read as a white flash followed by a
          // snap back down. Press and release now paint the same fill, and the
          // crossfade lets the outgoing row hand the highlight over.
          isSelected
            ? 'fd-row-selected'
            : 'hover:bg-interactive-hover active:bg-interactive-selected',
          isDragged && 'opacity-50',
        )}
        onClick={() => {
          // While the confirm pill is up, the row itself is the dismiss
          // affordance; selecting a thread mid-confirm would be surprising.
          if (archiveConfirm) {
            onArchiveCancel?.()
            return
          }
          onSelect(workspaceId, thread.id)
        }}
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
          if (archiveConfirm || !onRequestRename) return
          event.preventDefault()
          onRequestRename({ workspaceId, thread })
        }}
      >
        {projectMark ? (
          <span id={projectDescriptionId} className="sr-only">
            {projectMark.label}
          </span>
        ) : null}
        {depth > 0 ? (
          // The elbow lives inside the row so the selection fill runs behind
          // it, the way a native outline view draws its connectors. Negative
          // margins reach into the row's padding so a middle child's upright
          // meets the next sibling's with no seam.
          <span
            aria-hidden="true"
            data-testid="thread-nesting-connector"
            className="pointer-events-none relative -my-2 shrink-0 self-stretch"
            style={{ width: depth * NESTING_RUNG_PX }}
          >
            <span
              className="absolute top-0 h-1/2 rounded-bl-[var(--fd-radius-sm)] border-b border-l border-border-emphasis"
              style={{ left: (depth - 1) * NESTING_RUNG_PX + NESTING_LINE_PX, right: 2 }}
            />
            {Array.from({ length: depth }, (_, index) => index + 1)
              .filter((rung) => trunkMask & (1 << (rung - 1)))
              .map((rung) => (
                <span
                  key={rung}
                  className="absolute bottom-0 border-l border-border-emphasis"
                  style={{
                    left: (rung - 1) * NESTING_RUNG_PX + NESTING_LINE_PX,
                    // This row's own rung carries on from the elbow; an
                    // ancestor's runs the whole height, under the row.
                    top: rung === depth ? "50%" : 0,
                  }}
                />
              ))}
          </span>
        ) : null}
        <button
          type="button"
          aria-describedby={projectMark ? projectDescriptionId : undefined}
          className={cn(
            'fd-focus-inset flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--fd-radius-sm)] text-left transition-opacity duration-[var(--fd-duration-fast)]',
            archiveConfirm && 'pointer-events-none opacity-40',
          )}
          onClick={(event) => {
            // Selection also lives on the full row so the timestamp and
            // trailing space match the hover/selected hit area. Keep the
            // title button from selecting twice as the click bubbles up.
            event.stopPropagation()
            if (archiveConfirm) {
              onArchiveCancel?.()
              return
            }
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
              <span className="h-2.5 w-2.5 rounded-full bg-unread" />
            ) : null}
          </span>
          {projectMark ? (
            <span
              title={projectMark.label}
              className="flex h-4 w-4 shrink-0 items-center justify-center"
            >
              <WorkspaceIcon src={projectMark.src} color={projectMark.color} />
            </span>
          ) : null}
          <span
            className={cn(
              "fd-type-supporting min-w-0 flex-1 truncate transition-colors duration-[var(--fd-duration-fast)]",
              isSelected
                ? "text-fg-primary"
                : thread.is_archived
                  ? "text-fg-muted"
                  : "text-fg-secondary group-hover:text-fg-primary",
            )}
          >
            {thread.title}
          </span>
          {thread.origin?.kind === 'scheduled_task' ? (
            <span
              role="img"
              aria-label={`Automation: ${thread.origin.title}`}
              title={`Automation · ${thread.origin.title}`}
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
          {thread.origin?.kind === 'agent_spawn' ? (
            depth > 0 ? (
              // The elbow already says an agent started this one, so the row
              // spends the space on its title instead. Screen readers get the
              // relationship in words, since the connector is decorative.
              <span className="sr-only">Started by the chat above</span>
            ) : (
              <span
                role="img"
                aria-label="Created by an agent"
                title="Created by an agent"
                className="flex shrink-0 items-center text-fg-muted"
              >
                <Bot aria-hidden="true" className="h-3 w-3" />
              </span>
            )
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
        </button>
        {archiveConfirm ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onArchiveConfirm?.()
            }}
            aria-label={`Confirm archiving ${thread.title}`}
            className="fd-focus-fill -my-1 flex h-6 shrink-0 items-center rounded-full bg-danger px-3 text-[length:var(--fd-text-xs)] font-medium text-white transition-colors duration-[var(--fd-duration-fast)] hover:bg-danger/90"
          >
            Confirm
          </button>
        ) : (
          <>
            {thread.provider ? (
              // Keep the mark's space stable so revealing it does not shove
              // the timestamp around. Keyboard focus mirrors row hover, and
              // very narrow sidebars leave it out so the title keeps the room.
              <span
                data-testid="thread-provider-mark"
                role="img"
                aria-label={providerLabel ?? undefined}
                title={providerLabel ?? undefined}
                className="pointer-events-none hidden h-[18px] w-[18px] shrink-0 items-center justify-center text-fg-muted opacity-0 transition-opacity duration-[var(--fd-duration-fast)] group-focus-within:opacity-100 group-hover:opacity-100 group-[:hover]:opacity-100 @[13rem]:flex"
              >
                <ProviderIcon className="h-2.5 w-2.5" provider={thread.provider} />
              </span>
            ) : null}
            {thread.is_pinned || thread.is_pinned_in_project ? (
              <Pin
                role="img"
                aria-label={thread.is_pinned ? 'Pinned' : 'Pinned in project'}
                className="h-3 w-3 shrink-0 rotate-45 text-fg-muted"
              />
            ) : null}
            {/*
              The timestamp and the archive action share one grid cell and
              swap in place instead of reflowing the row. Hide the outgoing
              element immediately in either direction so the opacity fades
              never show both at once.
            */}
            <span className="group/actions grid shrink-0 grid-cols-1 items-center justify-items-end">
              {wasInterrupted ? (
                <Badge
                  variant="danger"
                  className={cn(
                    'col-start-1 row-start-1 transition-opacity duration-[var(--fd-duration-fast)]',
                    hoverAction &&
                      'group-hover:hidden group-[:hover]:hidden group-focus-within/actions:hidden group-hover:invisible group-[:hover]:invisible group-hover:opacity-0 group-focus-within/actions:invisible group-focus-within/actions:opacity-0',
                  )}
                >
                  Stopped
                </Badge>
              ) : attention.showBadge ? (
                <Badge
                  variant="success"
                  className={cn(
                    'col-start-1 row-start-1 transition-opacity duration-[var(--fd-duration-fast)]',
                    hoverAction &&
                      'group-hover:hidden group-[:hover]:hidden group-focus-within/actions:hidden group-hover:invisible group-[:hover]:invisible group-hover:opacity-0 group-focus-within/actions:invisible group-focus-within/actions:opacity-0',
                  )}
                >
                  {attention.badgeLabel}
                </Badge>
              ) : (
                <time
                  dateTime={thread.updated_at}
                  title={fullTimestamp}
                  className={cn(
                    'fd-type-meta col-start-1 row-start-1 text-fg-muted transition-opacity duration-[var(--fd-duration-fast)]',
                    hoverAction &&
                      'group-hover:hidden group-[:hover]:hidden group-focus-within/actions:hidden group-hover:invisible group-[:hover]:invisible group-hover:opacity-0 group-focus-within/actions:invisible group-focus-within/actions:opacity-0',
                  )}
                >
                  {timeString}
                </time>
              )}
              {hoverAction === 'archive' ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    void Promise.resolve(
                      onArchive?.(workspaceId, thread.id),
                    ).catch(() => {})
                  }}
                  title="Archive thread"
                  aria-label={`Archive thread ${thread.title}`}
                  className="fd-focus pointer-events-none hidden invisible z-10 col-start-1 row-start-1 items-center justify-center rounded-[var(--fd-radius-sm)] p-0.5 text-fg-muted opacity-0 transition-opacity duration-[var(--fd-duration-fast)] hover:text-fg-secondary focus-visible:pointer-events-auto focus-visible:visible focus-visible:opacity-100 focus-visible:flex group-hover:pointer-events-auto group-hover:visible group-hover:opacity-100 group-hover:flex group-[:hover]:pointer-events-auto group-[:hover]:visible group-[:hover]:opacity-100 group-[:hover]:flex"
                >
                  <Archive aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              ) : hoverAction === 'unarchive' ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    void Promise.resolve(
                      onUnarchive?.(workspaceId, thread.id),
                    ).catch(() => {})
                  }}
                  title="Unarchive thread"
                  aria-label={`Unarchive thread ${thread.title}`}
                  className="fd-focus pointer-events-none hidden invisible z-10 col-start-1 row-start-1 items-center justify-center rounded-[var(--fd-radius-sm)] p-0.5 text-fg-muted opacity-0 transition-opacity duration-[var(--fd-duration-fast)] hover:text-fg-secondary focus-visible:pointer-events-auto focus-visible:visible focus-visible:opacity-100 focus-visible:flex group-hover:pointer-events-auto group-hover:visible group-hover:opacity-100 group-hover:flex group-[:hover]:pointer-events-auto group-[:hover]:visible group-[:hover]:opacity-100 group-[:hover]:flex"
                >
                  <ArchiveRestore aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </span>
          </>
        )}
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
    projectMarkEqual(prev.projectMark, next.projectMark) &&
    prev.nowTick === next.nowTick &&
    prev.onSelect === next.onSelect &&
    prev.onArchive === next.onArchive &&
    prev.onUnarchive === next.onUnarchive &&
    prev.archiveConfirmPending === next.archiveConfirmPending &&
    prev.onArchiveConfirm === next.onArchiveConfirm &&
    prev.onArchiveCancel === next.onArchiveCancel &&
    prev.onOpenContextMenu === next.onOpenContextMenu &&
    prev.onRequestRename === next.onRequestRename &&
    tagsEqual(prev.tags, next.tags),
)

function projectMarkEqual(
  a: ThreadItemProps['projectMark'],
  b: ThreadItemProps['projectMark'],
) {
  if (a === b) return true
  // A row that omits the prop and a row that passes null render the same
  // empty slot. Compare those as equal, then compare real marks by value
  // because each snapshot builds a new object.
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  return a.src === b.src && a.color === b.color && a.label === b.label
}

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
    a.provider === b.provider &&
    a.updated_at === b.updated_at &&
    a.status === b.status &&
    a.last_error === b.last_error &&
    a.is_pinned === b.is_pinned &&
    a.is_pinned_in_project === b.is_pinned_in_project &&
    a.is_archived === b.is_archived &&
    a.variant?.slug === b.variant?.slug &&
    originEqual(a.origin, b.origin) &&
    a.attention.unread === b.attention.unread &&
    a.attention.badge_label === b.attention.badge_label &&
    a.attention.pending_approval_count === b.attention.pending_approval_count &&
    a.attention.pending_question_count === b.attention.pending_question_count &&
    a.attention.background_task_count === b.attention.background_task_count &&
    a.attention.last_agent_activity_seq ===
      b.attention.last_agent_activity_seq &&
    a.attention.last_read_seq === b.attention.last_read_seq
  )
}
