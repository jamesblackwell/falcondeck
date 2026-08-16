import { memo, useMemo, useState } from 'react'

import { CopyButton, cn } from '@falcondeck/ui'

import { languageFromPath, normalizeLanguage, useShikiTokens } from '../lib/shiki'
import { DiffBlock } from './diff-block'
import { looksLikeUnifiedDiff, useParsedDiff } from './diff-lines'

/**
 * Lines shown before a block is capped. Long command output (a `ps` dump, a
 * whole file read) otherwise pushes the conversation off screen — the cap
 * keeps the shape of the output visible while staying one click from full.
 */
const DEFAULT_PREVIEW_LINES = 14
const MAX_RENDERED_CHARS = 200_000
const MAX_EXPANDED_LINES = 1_000

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  filePath = null,
  previewLines = DEFAULT_PREVIEW_LINES,
  highlight = true,
}: {
  code: string
  language?: string | null
  /** File the code came from; its extension picks the grammar when `language` is absent. */
  filePath?: string | null
  /** Lines shown before capping; pass `0` to never cap (diffs, short output). */
  previewLines?: number
  /** Keep streamed content plain until it settles to avoid tokenizing every delta. */
  highlight?: boolean
}) {
  const [expanded, setExpanded] = useState(false)

  // Agents hand back patches as untagged text, so shape detection matters as
  // much as the explicit `diff` tag. Parsing is skipped for everything else.
  const isDiffCandidate =
    language === 'diff' || language === 'patch' || looksLikeUnifiedDiff(code)
  const parsedDiff = useParsedDiff(isDiffCandidate ? code : null)

  const resolvedLanguage = useMemo(
    () => normalizeLanguage(language) ?? languageFromPath(filePath),
    [filePath, language],
  )

  const displayCode = useMemo(() => code.slice(0, MAX_RENDERED_CHARS), [code])
  const lines = useMemo(() => displayCode.split('\n'), [displayCode])
  const expandedLineCount = Math.min(lines.length, MAX_EXPANDED_LINES)
  const previewLineCount = previewLines > 0
    ? Math.min(previewLines, expandedLineCount)
    : expandedLineCount
  const hiddenLineCount = Math.max(0, expandedLineCount - previewLineCount)
  const displayLimited = code.length > displayCode.length || lines.length > MAX_EXPANDED_LINES
  const isCapped = hiddenLineCount > 0 && !expanded
  const visibleLines = useMemo(
    () => lines.slice(0, isCapped ? previewLineCount : expandedLineCount),
    [expandedLineCount, isCapped, lines, previewLineCount],
  )
  // Only the rows on screen are tokenized; expanding re-runs over the whole
  // block, so a capped 2000-line dump costs 14 lines of highlighting.
  const tokens = useShikiTokens(visibleLines, highlight ? resolvedLanguage : null)

  if (parsedDiff.status !== 'unparsed') {
    return <DiffBlock diff={code} parsed={parsedDiff} previewRows={previewLines} />
  }

  return (
    <div className="overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-1">
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-1.5 text-[length:var(--fd-text-xs)] text-fg-muted">
        <span className="min-w-0 truncate">{filePath ?? language ?? resolvedLanguage ?? 'code'}</span>
        <div className="flex shrink-0 items-center gap-2">
          {(lines.length > previewLineCount || displayLimited) && previewLines > 0 ? (
            <span className="tabular-nums">
              {code.length > displayCode.length ? `${lines.length}+` : lines.length} lines
            </span>
          ) : null}
          <CopyButton text={code} variant="labeled" />
        </div>
      </div>
      <div className="relative">
        <pre
          data-syntax-highlighting={
            resolvedLanguage ? (highlight ? 'enabled' : 'deferred') : 'unavailable'
          }
          className="overflow-x-auto p-3 text-[length:var(--fd-text-sm)] leading-code text-fg-secondary"
        >
          <code>
            {tokens
              ? visibleLines.map((line, index) => (
                  <span key={index}>
                    {tokens[index]
                      ? tokens[index].map((token, tokenIndex) => (
                          <span key={tokenIndex} style={{ color: token.color }}>
                            {token.content}
                          </span>
                        ))
                      : line}
                    {index < visibleLines.length - 1 ? '\n' : null}
                  </span>
                ))
              : visibleLines.join('\n')}
          </code>
        </pre>
        {isCapped ? (
          // Fade the last rows so the cut reads as "more below", not as the end.
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface-1 to-transparent"
          />
        ) : null}
      </div>
      {hiddenLineCount > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className={cn(
            'fd-focus w-full border-t border-border-subtle px-3 py-1.5 text-left text-[length:var(--fd-text-xs)] text-fg-muted',
            'transition-colors hover:bg-surface-2 hover:text-fg-secondary',
          )}
        >
          {expanded ? 'Show less' : `Show ${hiddenLineCount} more line${hiddenLineCount === 1 ? '' : 's'}`}
        </button>
      ) : null}
      {displayLimited ? (
        <p role="status" className="border-t border-border-subtle px-3 py-1.5 text-[length:var(--fd-text-xs)] text-fg-muted">
          Display limited for performance. Copy includes the complete output.
        </p>
      ) : null}
    </div>
  )
})
