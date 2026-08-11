import { memo, useMemo, useState } from 'react'

import { CopyButton, cn } from '@falcondeck/ui'

import { FileDiffLink } from '../lib/file-diff-context'
import {
  buildDiffFileRows,
  capDiffFileRows,
  countDiffRows,
  DiffFileSection,
  type ParsedDiff,
} from './diff-lines'

/**
 * Rows shown before a diff is capped. A patch touching a whole package would
 * otherwise push the rest of the conversation off screen.
 */
const DEFAULT_PREVIEW_ROWS = 14
const MAX_EXPANDED_ROWS = 1_000

/**
 * A unified diff rendered as a diff — hunk headers, +/- gutters, line numbers
 * and syntax highlighting — inside the transcript.
 */
export const DiffBlock = memo(function DiffBlock({
  diff,
  parsed,
  previewRows = DEFAULT_PREVIEW_ROWS,
  title,
  filePath = null,
}: {
  diff: string
  /** Parsed once by the caller, which also decides whether a diff renderer fits. */
  parsed: ParsedDiff
  /** Rows shown before capping; pass `0` to never cap. */
  previewRows?: number
  /** Label when the diff names no file (a bare hunk with no `diff --git`). */
  title?: string
  /** Authoritative current path when provider metadata supersedes patch headers. */
  filePath?: string | null
}) {
  const [expanded, setExpanded] = useState(false)
  const fileRows = useMemo(
    () => (parsed.status === 'ok' ? buildDiffFileRows(parsed.files) : []),
    [parsed],
  )
  const totalRows = useMemo(() => countDiffRows(fileRows), [fileRows])
  const expandedRowCount = Math.min(totalRows, MAX_EXPANDED_ROWS)
  const previewRowCount = previewRows > 0
    ? Math.min(previewRows, expandedRowCount)
    : expandedRowCount
  const hiddenRowCount = Math.max(0, expandedRowCount - previewRowCount)
  const displayLimited = totalRows > MAX_EXPANDED_ROWS
  const isCapped = hiddenRowCount > 0 && !expanded
  const visibleFileRows = useMemo(
    () => capDiffFileRows(fileRows, isCapped ? previewRowCount : expandedRowCount),
    [expandedRowCount, fileRows, isCapped, previewRowCount],
  )

  const paths = useMemo(
    () => fileRows.flatMap((file) => (file.path ? [file.path] : [])),
    [fileRows],
  )

  return (
    <div className="overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-1">
      <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-1.5 text-[length:var(--fd-text-xs)] text-fg-muted">
        <span className="min-w-0 truncate font-mono">
          {filePath ? (
            <FileDiffLink filePath={filePath} className="text-fg-secondary" />
          ) : paths.length === 1 ? (
            <FileDiffLink filePath={paths[0]} className="text-fg-secondary" />
          ) : paths.length > 1 ? (
            `${paths.length} files changed`
          ) : (
            title ?? 'diff'
          )}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {parsed.status === 'too-large' ? null : (
            <span className="tabular-nums">
              {totalRows} line{totalRows === 1 ? '' : 's'}
            </span>
          )}
          <CopyButton text={diff} variant="labeled" />
        </div>
      </div>

      {parsed.status === 'too-large' ? (
        <p className="p-3 text-[length:var(--fd-text-xs)] text-fg-muted">
          Diff too large to display.
        </p>
      ) : (
        <div className="relative">
          <div className="overflow-x-auto p-1 font-mono text-[length:var(--fd-text-2xs)] leading-5">
            {visibleFileRows.map((file, index) => (
              <DiffFileSection
                key={file.path ?? index}
                path={file.path}
                rows={file.rows}
                header={
                  // Only worth naming when a single block spans several files;
                  // otherwise the panel header above already says which file.
                  visibleFileRows.length > 1 && file.path ? (
                    <div className="border-b border-border-subtle px-2 py-1 text-fg-tertiary">
                      <FileDiffLink filePath={file.path} />
                    </div>
                  ) : undefined
                }
              />
            ))}
          </div>
          {isCapped ? (
            // Fade the last rows so the cut reads as "more below", not the end.
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface-1 to-transparent"
            />
          ) : null}
        </div>
      )}

      {hiddenRowCount > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className={cn(
            'fd-focus w-full border-t border-border-subtle px-3 py-1.5 text-left text-[length:var(--fd-text-xs)] text-fg-muted',
            'transition-colors hover:bg-surface-2 hover:text-fg-secondary',
          )}
        >
          {expanded ? 'Show less' : `Show ${hiddenRowCount} more line${hiddenRowCount === 1 ? '' : 's'}`}
        </button>
      ) : null}
      {displayLimited ? (
        <p role="status" className="border-t border-border-subtle px-3 py-1.5 text-[length:var(--fd-text-xs)] text-fg-muted">
          Display limited to 1,000 diff lines for performance. Copy includes the complete diff.
        </p>
      ) : null}
    </div>
  )
})
