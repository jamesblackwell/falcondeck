import { memo, useMemo, useState, type ReactNode } from 'react'
import {
  ChevronDown,
  FileDiff,
  FolderClosed,
  GitBranch,
  Globe,
  Laptop,
  Split,
  Waypoints,
} from 'lucide-react'

import type { GitStatusEntry, ThreadSummary } from '@falcondeck/client-core'
import { CopyButton } from '@falcondeck/ui'

import { FileTypeIcon } from './FileTypeIcon'
import { basePart, dirPart, statusLabel, statusToneClass } from './diff-utils'

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
}

/** How many changed files show before the list collapses behind "Show N more". */
const PREVIEW_LIMIT = 5

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
  if (thread.handoff_from) return `Handed off from ${thread.handoff_from.provider}`
  return null
}

/** One `label: value` line. Passing `copy` appends a copy button for a value
 * worth pasting elsewhere — a path or a branch name. */
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
    <div className="flex min-w-0 items-center gap-2 px-3 py-1.5">
      <span className="flex w-32 shrink-0 items-center gap-2 text-[length:var(--fd-text-sm)] text-fg-muted">
        <span className="shrink-0 text-fg-faint">{icon}</span>
        <span className="truncate">{label}</span>
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1 text-[length:var(--fd-text-sm)] text-fg-primary">
        {children}
        {copy ? <CopyButton text={copy} label={`Copy ${label.toLowerCase()}`} className="h-5 w-5" /> : null}
      </span>
    </div>
  )
}

export const InfoView = memo(function InfoView({
  info,
  entries,
  branch,
  isLoading,
  error,
  onSelectChangedFile,
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
  const visibleEntries = expanded ? entries : entries.slice(0, PREVIEW_LIMIT)
  const hiddenCount = entries.length - visibleEntries.length

  return (
    <div className="pb-4 pt-2">
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
            className={`ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${
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
          {/* Paths are the row most worth reading in full, so this one wraps
              rather than truncating the tail that identifies the checkout. */}
          <span className="min-w-0 break-all" title={directory}>
            {directory}
          </span>
        </Row>
      ) : null}

      {branch ? (
        <Row
          icon={<GitBranch aria-hidden="true" className="h-3.5 w-3.5" />}
          label="Branch"
          copy={branch}
        >
          <span className="truncate" title={branch}>
            {branch}
          </span>
        </Row>
      ) : null}

      <Row icon={<FileDiff aria-hidden="true" className="h-3.5 w-3.5" />} label="Git status">
        {isLoading && entries.length === 0 ? (
          <span className="text-fg-muted">Checking…</span>
        ) : error ? (
          <span className="truncate text-danger" title={error}>
            {error}
          </span>
        ) : entries.length ? (
          <span className="font-medium text-warning">Dirty</span>
        ) : (
          <span className="text-fg-muted">Clean</span>
        )}
      </Row>

      {entries.length ? (
        <div className="mt-3">
          <div className="flex items-center gap-2 px-3 pb-1">
            <span className="w-32 shrink-0 text-[length:var(--fd-text-sm)] text-fg-muted">
              Uncommitted
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[length:var(--fd-text-sm)] tabular-nums">
              <span className="text-fg-primary">
                {entries.length} {entries.length === 1 ? 'file' : 'files'},
              </span>
              <span className="text-success">+{totals.insertions}</span>
              <span className="text-danger">-{totals.deletions}</span>
            </span>
          </div>

          {visibleEntries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => onSelectChangedFile(entry)}
              className="fd-focus-inset flex h-7 w-full items-center gap-2 px-3 text-left hover:bg-surface-2"
            >
              <span
                className={`w-3 shrink-0 text-center text-[length:var(--fd-text-xs)] ${statusToneClass(entry.status)}`}
              >
                {statusLabel(entry.status)}
              </span>
              <FileTypeIcon path={entry.path} />
              <span className="min-w-0 flex-1 truncate text-[length:var(--fd-text-sm)]">
                <span className="text-fg-muted">{dirPart(entry.path)}</span>
                <span className="text-fg-secondary">{basePart(entry.path)}</span>
              </span>
            </button>
          ))}

          {hiddenCount > 0 || expanded ? (
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
          ) : null}
        </div>
      ) : null}
    </div>
  )
})
