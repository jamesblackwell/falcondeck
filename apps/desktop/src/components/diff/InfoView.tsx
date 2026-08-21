import { memo, useMemo, useState, type ReactNode } from 'react'
import {
  Check,
  ChevronDown,
  FolderClosed,
  GitBranch,
  Globe,
  Laptop,
  Split,
  Waypoints,
} from 'lucide-react'

import type { GitStatusEntry, ThreadSummary } from '@falcondeck/client-core'
import { ActivityDiamond, Badge, CopyButton } from '@falcondeck/ui'

import { FileTypeIcon } from './FileTypeIcon'
import {
  basePart,
  dirPart,
  homeRelativePath,
  statusLabel,
  statusToneClass,
} from './diff-utils'

/** Everything the info tab needs that the review panel does not already load. */
export type ReviewInfoContext = {
  /** Absolute path of the project folder on its host. */
  workspacePath: string | null
  /** Enrolled remote host the workspace lives on; null means this Mac. */
  hostName: string | null
  hostConnected?: boolean
  thread: ThreadSummary | null
}

export type InfoViewProps = {
  info: ReviewInfoContext
  entries: GitStatusEntry[]
  branch: string | null
  isLoading: boolean
  error: string | null
  onSelectChangedFile: (entry: GitStatusEntry) => void
  /** Hands a large changeset to the changes tab, which is virtualised. */
  onViewAllChanges: () => void
}

/** How many changed files show before the list collapses. */
const PREVIEW_LIMIT = 5
/** Above this, expanding in place would render hundreds of unvirtualised rows,
 * so the overview defers to the changes tab instead. */
const EXPANDABLE_MAX = 25

const SECTION_HEADING_CLASS =
  'text-[length:var(--fd-text-2xs)] font-medium uppercase tracking-[0.08em] text-fg-muted'

/** The one-line description of where this thread came from, when it was not
 * started by hand. */
function originLabel(thread: ThreadSummary | null): string | null {
  if (!thread) return null
  if (thread.origin?.kind === 'scheduled_task') {
    return `Scheduled task · ${thread.origin.title}`
  }
  if (thread.origin?.kind === 'automation') {
    return `Automation · ${thread.origin.name}`
  }
  if (thread.handoff_from) {
    // "Fork thread" on a provider with no native session-fork RPC is
    // implemented as a same-provider handoff (see workspace_ops.rs), so a
    // same-provider `handoff_from` is a fork, not a genuine cross-provider
    // continuation — the two need different copy here.
    return thread.handoff_from.provider === thread.provider
      ? 'Forked from an earlier thread'
      : `Handed off from ${thread.handoff_from.provider}`
  }
  return null
}

/** One `label: value` line. Passing `copy` adds a copy button that stays out of
 * the way until the row is hovered or the button itself is focused. */
function Row({
  icon,
  label,
  copy,
  children,
}: {
  icon: ReactNode
  label: string
  copy?: string
  children: ReactNode
}) {
  return (
    <div className="group flex min-w-0 items-baseline gap-3 px-3 py-1">
      <span className="flex w-28 shrink-0 items-center gap-2 text-[length:var(--fd-text-sm)] text-fg-muted">
        <span className="shrink-0 text-fg-faint">{icon}</span>
        <span className="truncate">{label}</span>
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1 text-[length:var(--fd-text-sm)] text-fg-secondary">
        {children}
        {copy ? (
          <CopyButton
            text={copy}
            label={`Copy ${label.toLowerCase()}`}
            className="h-5 w-5 self-center opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100"
          />
        ) : null}
      </span>
    </div>
  )
}

/** Proportional insertions-to-deletions bar, the shape of the change at a glance. */
function DiffBar({ insertions, deletions }: { insertions: number; deletions: number }) {
  const total = insertions + deletions
  if (total === 0) return null
  return (
    <span
      aria-hidden="true"
      className="flex h-1 min-w-8 max-w-24 flex-1 overflow-hidden rounded-[var(--fd-radius-full)] bg-surface-3"
    >
      <span className="bg-success" style={{ width: `${(insertions / total) * 100}%` }} />
      <span className="bg-danger" style={{ width: `${(deletions / total) * 100}%` }} />
    </span>
  )
}

export const InfoView = memo(function InfoView({
  info,
  entries,
  branch,
  isLoading,
  error,
  onSelectChangedFile,
  onViewAllChanges,
}: InfoViewProps) {
  const [expanded, setExpanded] = useState(false)
  const totals = useMemo(
    () =>
      entries.reduce(
        (sum, entry) => ({
          insertions: sum.insertions + (entry.insertions ?? 0),
          deletions: sum.deletions + (entry.deletions ?? 0),
        }),
        { insertions: 0, deletions: 0 },
      ),
    [entries],
  )
  const variant = info.thread?.variant ?? null
  // An isolated thread runs in its own checkout, so the project folder path
  // would be the wrong directory to show — and the wrong one to copy.
  const directory = variant?.path ?? info.workspacePath
  const origin = originLabel(info.thread)
  const expandable = entries.length <= EXPANDABLE_MAX
  const visibleEntries = expanded ? entries : entries.slice(0, PREVIEW_LIMIT)
  const hiddenCount = entries.length - visibleEntries.length

  return (
    <div className="pb-4 pt-3">
      {origin ? (
        <Row icon={<Waypoints aria-hidden="true" className="h-3.5 w-3.5" />} label="Origin">
          <span className="truncate">{origin}</span>
        </Row>
      ) : null}

      <Row
        icon={
          info.hostName ? (
            <Globe aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <Laptop aria-hidden="true" className="h-3.5 w-3.5" />
          )
        }
        label="Environment"
      >
        <span className="truncate">{info.hostName ?? 'Local'}</span>
        {info.hostName ? (
          <span
            aria-hidden="true"
            className={`ml-1 h-1.5 w-1.5 shrink-0 self-center rounded-full ${
              info.hostConnected ? 'bg-success' : 'bg-fg-muted'
            }`}
          />
        ) : null}
      </Row>

      {info.thread ? (
        <Row
          icon={
            variant ? (
              <Split aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <FolderClosed aria-hidden="true" className="h-3.5 w-3.5" />
            )
          }
          label="Works in"
        >
          <span className="truncate">
            {variant ? `Isolated ${variant.kind}` : 'Project folder'}
          </span>
        </Row>
      ) : null}

      {directory ? (
        <Row
          icon={<FolderClosed aria-hidden="true" className="h-3.5 w-3.5" />}
          label="Directory"
          copy={directory}
        >
          {/* Abbreviated to keep the checkout on one line; the tooltip and the
              copy button both still carry the absolute path. */}
          <span
            className="truncate font-mono text-[length:var(--fd-text-xs)]"
            title={directory}
          >
            {homeRelativePath(directory)}
          </span>
        </Row>
      ) : null}

      {branch ? (
        <Row
          icon={<GitBranch aria-hidden="true" className="h-3.5 w-3.5" />}
          label="Branch"
          copy={branch}
        >
          <span className="truncate font-mono text-[length:var(--fd-text-xs)]" title={branch}>
            {branch}
          </span>
        </Row>
      ) : null}

      <div className="mt-3 border-t border-border-subtle pt-3">
        {error ? (
          <p className="px-3 text-[length:var(--fd-text-xs)] text-danger">{error}</p>
        ) : isLoading && entries.length === 0 ? (
          <p className="flex items-center gap-2 px-3 text-[length:var(--fd-text-sm)] text-fg-muted">
            <ActivityDiamond tone="current" />
            Checking the working tree…
          </p>
        ) : entries.length === 0 ? (
          <p className="flex items-center gap-2 px-3 text-[length:var(--fd-text-sm)] text-fg-muted">
            <Check aria-hidden="true" className="h-3.5 w-3.5 text-success" />
            Working tree clean
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2 px-3">
              <span className={SECTION_HEADING_CLASS}>Uncommitted</span>
              {/* The section title already says these are uncommitted, so the
                  count stays neutral — amber is kept for real warnings. */}
              <Badge className="ml-auto tabular-nums">
                {entries.length} {entries.length === 1 ? 'file' : 'files'}
              </Badge>
            </div>

            <div className="flex items-center gap-2 px-3 pb-1 pt-1.5 text-[length:var(--fd-text-xs)] tabular-nums">
              <span className="text-success">+{totals.insertions}</span>
              <span className="text-danger">-{totals.deletions}</span>
              <DiffBar insertions={totals.insertions} deletions={totals.deletions} />
            </div>

            {visibleEntries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                onClick={() => onSelectChangedFile(entry)}
                className="fd-focus-inset group flex h-7 w-full items-center gap-2 px-3 text-left hover:bg-surface-2"
              >
                <span
                  className={`w-3 shrink-0 text-center text-[length:var(--fd-text-xs)] font-medium ${statusToneClass(
                    entry.status,
                  )}`}
                >
                  {statusLabel(entry.status)}
                </span>
                <FileTypeIcon path={entry.path} />
                <span className="min-w-0 flex-1 truncate text-[length:var(--fd-text-sm)]">
                  <span className="text-fg-faint">{dirPart(entry.path)}</span>
                  <span className="text-fg-secondary group-hover:text-fg-primary">
                    {basePart(entry.path)}
                  </span>
                </span>
              </button>
            ))}

            {expandable && (hiddenCount > 0 || expanded) ? (
              <button
                type="button"
                onClick={() => setExpanded((previous) => !previous)}
                className="fd-focus-inset flex h-7 w-full items-center gap-1.5 px-3 text-left text-[length:var(--fd-text-sm)] text-fg-muted hover:bg-surface-2 hover:text-fg-secondary"
              >
                <ChevronDown
                  aria-hidden="true"
                  className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
                />
                {expanded ? 'Show less' : `Show ${hiddenCount} more`}
              </button>
            ) : !expandable ? (
              <button
                type="button"
                onClick={onViewAllChanges}
                className="fd-focus-inset flex h-7 w-full items-center gap-1.5 px-3 text-left text-[length:var(--fd-text-sm)] text-fg-muted hover:bg-surface-2 hover:text-fg-secondary"
              >
                <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 -rotate-90" />
                View all {entries.length} in Changes
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
})
