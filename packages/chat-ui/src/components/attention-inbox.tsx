import { memo, useMemo, useState } from 'react'
import { Bell, ChevronDown } from 'lucide-react'

import {
  deriveThreadAttentionPresentation,
  type ProjectGroup,
  type ThreadSummary,
} from '@falcondeck/client-core'
import { cn } from '@falcondeck/ui'

const MAX_INBOX_ITEMS = 8

type InboxEntry = {
  thread: ThreadSummary
  workspaceId: string
  projectLabel: string
  tone: 'warning' | 'danger'
  reason: string
  priority: number
}

export function collectAttentionEntries(groups: ProjectGroup[]): InboxEntry[] {
  const entries: InboxEntry[] = []
  for (const group of groups) {
    const projectLabel = group.workspace.path.split('/').pop() ?? group.workspace.path
    for (const thread of group.threads) {
      if (thread.is_archived) continue
      const attention = deriveThreadAttentionPresentation(thread)
      if (attention.level === 'awaiting_response') {
        entries.push({
          thread,
          workspaceId: group.workspace.id,
          projectLabel,
          tone: 'warning',
          reason: attention.badgeLabel ?? 'Awaiting response',
          priority: 0,
        })
      } else if (attention.level === 'error') {
        // Errors are attention-worthy only until seen: viewing the thread
        // marks it read, which acknowledges the failure. Without this gate a
        // failed thread would sit in the inbox forever with no way to clear it.
        if (!attention.unread) continue
        entries.push({
          thread,
          workspaceId: group.workspace.id,
          projectLabel,
          tone: 'danger',
          reason: 'Failed',
          priority: 1,
        })
      }
      // Unread-only threads stay in the project list (unread dot there). They
      // are not "needs attention" — that section is for action or failure.
    }
  }
  return entries.sort(
    (a, b) =>
      a.priority - b.priority ||
      Date.parse(b.thread.updated_at) - Date.parse(a.thread.updated_at),
  )
}

const TONE_DOT: Record<InboxEntry['tone'], string> = {
  warning: 'bg-warning shadow-[0_0_0_3px_var(--fd-warning-muted)]',
  danger: 'bg-danger',
}

const TONE_TEXT: Record<InboxEntry['tone'], string> = {
  warning: 'text-warning',
  danger: 'text-danger',
}

export type AttentionInboxProps = {
  groups: ProjectGroup[]
  selectedThreadId: string | null
  onSelectThread: (workspaceId: string, threadId: string) => void
}

/**
 * Pinned "Needs attention" section for the sidebar: threads waiting on an
 * approval or answer, and failed runs that have not been viewed yet — across
 * every project. Plain unread messages stay in the project list. Renders
 * nothing when nothing needs action.
 */
export const AttentionInbox = memo(function AttentionInbox({
  groups,
  selectedThreadId,
  onSelectThread,
}: AttentionInboxProps) {
  // TODO(Activity view): consider removing this compact duplicate once the
  // full Activity surface in docs/ACTIVITY-VIEW.md has proven itself.
  const [collapsed, setCollapsed] = useState(false)
  // The selected thread is excluded: the user is already looking at it, and
  // its unread/running churn would pop the inbox in and out on every message,
  // making the whole sidebar jump.
  const entries = useMemo(
    () =>
      collectAttentionEntries(groups).filter((entry) => entry.thread.id !== selectedThreadId),
    [groups, selectedThreadId],
  )

  if (entries.length === 0) return null

  const visible = entries.slice(0, MAX_INBOX_ITEMS)
  const overflow = entries.length - visible.length

  return (
    <section
      aria-label={`Needs attention: ${entries.length} threads`}
      className="mb-4 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 p-1"
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
        className="fd-focus-fill flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-1.5 py-1.5 text-left focus-visible:bg-surface-3"
      >
        <Bell aria-hidden="true" className="h-3.5 w-3.5 text-warning" />
        <span className="flex-1 text-[length:var(--fd-text-xs)] font-medium uppercase tracking-[0.08em] text-fg-secondary">
          Needs attention
        </span>
        <span className="rounded-full bg-warning-muted px-1.5 py-0.5 text-[length:var(--fd-text-2xs)] font-semibold text-warning">
          {entries.length}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn('h-3 w-3 text-fg-muted transition-transform', collapsed && '-rotate-90')}
        />
      </button>

      {!collapsed ? (
        <div className="mt-0.5">
          {visible.map((entry) => (
            <button
              key={entry.thread.id}
              type="button"
              onClick={() => onSelectThread(entry.workspaceId, entry.thread.id)}
              className={cn(
                'fd-focus-fill flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-1.5 py-1.5 text-left',
                'transition-colors duration-[var(--fd-duration-fast)]',
                // Same ladder as the thread rows below: hover lifts, pressing
                // previews the selection fill so release is not a colour change.
                selectedThreadId === entry.thread.id
                  ? 'fd-row-selected'
                  : 'hover:bg-interactive-hover focus-visible:bg-interactive-hover active:bg-interactive-selected',
              )}
            >
              <span
                aria-hidden="true"
                className={cn('h-2 w-2 shrink-0 rounded-full', TONE_DOT[entry.tone])}
              />
              <span className="min-w-0 flex-1">
                <span className="fd-type-supporting block truncate text-fg-primary">
                  {entry.thread.title}
                </span>
                <span className="block truncate text-[length:var(--fd-text-2xs)] text-fg-muted">
                  {entry.projectLabel}
                </span>
              </span>
              <span
                className={cn(
                  'shrink-0 text-[length:var(--fd-text-2xs)] font-medium',
                  TONE_TEXT[entry.tone],
                )}
              >
                {entry.reason}
              </span>
            </button>
          ))}
          {overflow > 0 ? (
            <p className="px-1.5 py-1 text-[length:var(--fd-text-2xs)] text-fg-muted">
              +{overflow} more below
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
})
