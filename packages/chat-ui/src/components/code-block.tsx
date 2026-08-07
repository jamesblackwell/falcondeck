import { memo, useMemo, useState } from 'react'

import { CopyButton, cn } from '@falcondeck/ui'

/**
 * Lines shown before a block is capped. Long command output (a `ps` dump, a
 * whole file read) otherwise pushes the conversation off screen — the cap
 * keeps the shape of the output visible while staying one click from full.
 */
const DEFAULT_PREVIEW_LINES = 14

function DiffLine({ line }: { line: string }) {
  if (line.startsWith('+++') || line.startsWith('---')) {
    return <span className="text-fg-tertiary">{line}</span>
  }
  if (line.startsWith('+')) {
    return <span className="text-success">{line}</span>
  }
  if (line.startsWith('-')) {
    return <span className="text-danger">{line}</span>
  }
  if (line.startsWith('@@')) {
    return <span className="text-info">{line}</span>
  }
  return <span>{line}</span>
}

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  previewLines = DEFAULT_PREVIEW_LINES,
}: {
  code: string
  language?: string | null
  /** Lines shown before capping; pass `0` to never cap (diffs, short output). */
  previewLines?: number
}) {
  const isDiff = language === 'diff'
  const [expanded, setExpanded] = useState(false)

  const lines = useMemo(() => code.split('\n'), [code])
  const hiddenLineCount = previewLines > 0 ? Math.max(0, lines.length - previewLines) : 0
  const isCapped = hiddenLineCount > 0 && !expanded
  const visibleCode = isCapped ? lines.slice(0, previewLines).join('\n') : code

  return (
    <div className="overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-1">
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-1.5 text-[length:var(--fd-text-xs)] text-fg-muted">
        <span>{language ?? 'code'}</span>
        <div className="flex items-center gap-2">
          {lines.length > previewLines && previewLines > 0 ? (
            <span className="tabular-nums">{lines.length} lines</span>
          ) : null}
          <CopyButton text={code} variant="labeled" />
        </div>
      </div>
      <div className="relative">
        <pre className="overflow-x-auto p-3 text-[length:var(--fd-text-sm)] leading-relaxed text-fg-secondary">
          <code>
            {isDiff
              ? visibleCode.split('\n').map((line, i) => (
                  <span key={`${i}-${line.slice(0, 20)}`}>
                    <DiffLine line={line} />
                    {'\n'}
                  </span>
                ))
              : visibleCode}
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
    </div>
  )
})
