import { memo, useMemo } from 'react'
import parseDiff from 'parse-diff'
import type { Change, File } from 'parse-diff'
import type { ThemedToken } from 'shiki'

import { cn } from '@falcondeck/ui'

import { languageFromPath, useShikiTokens } from '../lib/shiki'

/* ================================================================
   Unified-diff rendering shared by the conversation transcript and
   the desktop working-tree sidebar: one parser, one set of gutters,
   one highlighting path.
   ================================================================ */

/** Parsing a diff this large costs more than showing it is worth. */
const MAX_DIFF_CHARS = 200_000

export function stripDiffPrefix(content: string) {
  if (content.length > 0 && (content[0] === '+' || content[0] === '-' || content[0] === ' ')) {
    return content.slice(1)
  }
  return content
}

/**
 * Whether `text` is a unified diff rather than ordinary tool output. Agents
 * hand back patches as plain text with no language tag, so the transcript has
 * to recognise them by shape.
 */
export function looksLikeUnifiedDiff(text: string): boolean {
  if (!text) return false
  const lines = text.split('\n', 40)
  let sawHeader = false
  for (const line of lines) {
    if (line.startsWith('diff --git ')) return true
    // A `---`/`+++` pair or a hunk header is the weakest reliable signal; a
    // lone `+`-prefixed line is far too common in ordinary command output.
    if (line.startsWith('@@ ') && line.includes(' @@')) return true
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      if (sawHeader) return true
      sawHeader = true
    }
  }
  return false
}

export type ParsedDiff =
  | { status: 'ok'; files: File[] }
  | { status: 'too-large' }
  | { status: 'unparsed' }

/** Memoized {@link parseUnifiedDiff}; pass null to skip parsing entirely. */
export function useParsedDiff(diff: string | null): ParsedDiff {
  return useMemo(() => parseUnifiedDiff(diff), [diff])
}

export function parseUnifiedDiff(diff: string | null | undefined): ParsedDiff {
  if (!diff) return { status: 'unparsed' }
  if (diff.length > MAX_DIFF_CHARS) return { status: 'too-large' }
  try {
    const files = parseDiff(diff).filter((file) => file.chunks.length > 0)
    return files.length > 0 ? { status: 'ok', files } : { status: 'unparsed' }
  } catch {
    return { status: 'unparsed' }
  }
}

/** The path a diffed file has now — its post-image name, or its old name if deleted. */
export function diffFilePath(file: File): string | null {
  const to = file.to && file.to !== '/dev/null' ? file.to : null
  const from = file.from && file.from !== '/dev/null' ? file.from : null
  return to ?? from
}

export type DiffRow =
  | { kind: 'hunk'; content: string }
  | { kind: 'change'; change: Change }

export type DiffFileRows = {
  path: string | null
  rows: DiffRow[]
}

/** Flattens parsed files into renderable rows, preserving hunk boundaries. */
export function buildDiffFileRows(files: File[]): DiffFileRows[] {
  return files.map((file) => {
    const rows: DiffRow[] = []
    for (const chunk of file.chunks) {
      rows.push({ kind: 'hunk', content: chunk.content })
      for (const change of chunk.changes) {
        rows.push({ kind: 'change', change })
      }
    }
    return { path: diffFilePath(file), rows }
  })
}

export function countDiffRows(fileRows: DiffFileRows[]) {
  return fileRows.reduce((total, file) => total + file.rows.length, 0)
}

/**
 * Truncates a flattened diff to at most `limit` rows, dropping whole files
 * once the budget runs out so the visible remainder still parses as a diff.
 */
export function capDiffFileRows(fileRows: DiffFileRows[], limit: number): DiffFileRows[] {
  if (limit <= 0) return fileRows

  const capped: DiffFileRows[] = []
  let remaining = limit
  for (const file of fileRows) {
    if (remaining <= 0) break
    capped.push({ path: file.path, rows: file.rows.slice(0, remaining) })
    remaining -= file.rows.length
  }
  return capped
}

function oldLineNumber(change: Change) {
  if (change.type === 'add') return ''
  return change.type === 'del' ? change.ln : change.ln1
}

function newLineNumber(change: Change) {
  if (change.type === 'del') return ''
  return change.type === 'add' ? change.ln : change.ln2
}

export const DiffChangeLine = memo(function DiffChangeLine({
  change,
  tokens,
}: {
  change: Change
  tokens: ThemedToken[] | null
}) {
  const prefix = change.content[0] ?? ' '

  return (
    <div
      className={cn(
        'flex',
        change.type === 'add' && 'bg-success-muted/20',
        change.type === 'del' && 'bg-danger-muted/20',
      )}
    >
      <span className="sticky left-0 z-10 w-7 shrink-0 select-none bg-inherit pr-0.5 text-right text-fg-muted">
        {oldLineNumber(change)}
      </span>
      <span className="w-7 shrink-0 select-none pr-1 text-right text-fg-muted">
        {newLineNumber(change)}
      </span>
      <span
        className={cn(
          'w-3 shrink-0 select-none text-center',
          change.type === 'add' ? 'text-success' : change.type === 'del' ? 'text-danger' : 'text-fg-muted',
        )}
      >
        {prefix}
      </span>
      <span className="whitespace-pre">
        {tokens
          ? tokens.map((token, index) => (
              <span key={index} style={{ color: token.color }}>
                {token.content}
              </span>
            ))
          : stripDiffPrefix(change.content)}
      </span>
    </div>
  )
})

export const HighlightedFileLine = memo(function HighlightedFileLine({
  lineNumber,
  tokens,
  text,
}: {
  lineNumber: number
  tokens: ThemedToken[] | null
  text: string
}) {
  return (
    <div className="flex">
      <span className="sticky left-0 z-10 w-12 shrink-0 select-none bg-surface-1 pr-2 text-right text-fg-muted">
        {lineNumber}
      </span>
      <span className="whitespace-pre">
        {tokens
          ? tokens.map((token, index) => (
              <span key={index} style={{ color: token.color }}>
                {token.content}
              </span>
            ))
          : text}
      </span>
    </div>
  )
})

/**
 * One file's worth of diff rows. Highlighting is scoped per file so a patch
 * spanning a `.rs` and a `.tsx` gets the right grammar for each, and only the
 * rows currently on screen are tokenized.
 */
export const DiffFileSection = memo(function DiffFileSection({
  path,
  rows,
  header,
}: {
  path: string | null
  rows: DiffRow[]
  /** Rendered above the rows; omitted by callers that name the file elsewhere. */
  header?: React.ReactNode
}) {
  const language = useMemo(() => languageFromPath(path), [path])
  const changeLines = useMemo(
    () =>
      rows.flatMap((row) => (row.kind === 'change' ? [stripDiffPrefix(row.change.content)] : [])),
    [rows],
  )
  const tokens = useShikiTokens(changeLines, language)

  let changeIndex = 0

  return (
    <div>
      {header}
      {rows.map((row, index) => {
        if (row.kind === 'hunk') {
          return (
            <div
              key={index}
              className="sticky left-0 border-y border-border-subtle bg-surface-2 px-2 py-0.5 text-fg-muted"
            >
              {row.content}
            </div>
          )
        }
        const tokenIndex = changeIndex++
        return (
          <DiffChangeLine key={index} change={row.change} tokens={tokens?.[tokenIndex] ?? null} />
        )
      })}
    </div>
  )
})
