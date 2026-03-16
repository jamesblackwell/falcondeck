import { memo, useMemo } from 'react'
import { ArrowLeft, LoaderCircle } from 'lucide-react'
import parseDiff from 'parse-diff'
import type { Change } from 'parse-diff'
import type { ThemedToken } from 'shiki'

import { Button } from '@falcondeck/ui'

import { useShikiTokens } from '../../hooks/useShiki'
import { stripPrefix } from './diff-utils'

function HighlightedDiffLine({
  change,
  tokens,
}: {
  change: Change
  tokens: ThemedToken[] | null
}) {
  const prefix = change.content[0] ?? ' '
  const bgClass =
    change.type === 'add'
      ? 'bg-success-muted/20'
      : change.type === 'del'
        ? 'bg-danger-muted/20'
        : ''

  return (
    <div className={`flex ${bgClass}`}>
      <span className="sticky left-0 z-10 w-7 shrink-0 select-none bg-inherit pr-0.5 text-right text-fg-faint">
        {change.type !== 'add' && 'ln1' in change ? change.ln1 : ''}
      </span>
      <span className="w-7 shrink-0 select-none pr-1 text-right text-fg-faint">
        {change.type !== 'del' && 'ln2' in change ? change.ln2 : ''}
      </span>
      <span
        className={`w-3 shrink-0 select-none text-center ${
          change.type === 'add'
            ? 'text-success'
            : change.type === 'del'
              ? 'text-danger'
              : 'text-fg-faint'
        }`}
      >
        {prefix}
      </span>
      <span className="whitespace-pre">
        {tokens ? (
          tokens.map((token, ti) => (
            <span key={ti} style={{ color: token.color }}>
              {token.content}
            </span>
          ))
        ) : (
          stripPrefix(change.content)
        )}
      </span>
    </div>
  )
}

export type DiffViewProps = {
  filePath: string
  diff: string | null
  isLoading: boolean
  error: string | null
  onBack: () => void
}

export const DiffView = memo(function DiffView({
  filePath,
  diff,
  isLoading,
  error,
  onBack,
}: DiffViewProps) {
  const parsed = useMemo(() => {
    if (!diff) return null
    if (diff.length > 200_000) return 'too-large' as const
    try {
      return parseDiff(diff)
    } catch {
      return null
    }
  }, [diff])

  const { codeLines, lineIndexMap } = useMemo(() => {
    if (!parsed || parsed === 'too-large') return { codeLines: [] as string[], lineIndexMap: new Map<number, number>() }

    const lines: string[] = []
    const indexMap = new Map<number, number>()
    let globalIndex = 0

    for (const file of parsed) {
      for (const chunk of file.chunks) {
        for (const change of chunk.changes) {
          indexMap.set(globalIndex, lines.length)
          lines.push(stripPrefix(change.content))
          globalIndex++
        }
      }
    }

    return { codeLines: lines, lineIndexMap: indexMap }
  }, [parsed])

  const shikiTokens = useShikiTokens(codeLines, filePath)

  const tokenMap = useMemo(() => {
    if (!shikiTokens) return null
    const map = new Map<number, ThemedToken[]>()
    for (const [globalIndex, codeLineIndex] of lineIndexMap.entries()) {
      if (codeLineIndex < shikiTokens.length) {
        map.set(globalIndex, shikiTokens[codeLineIndex])
      }
    }
    return map
  }, [shikiTokens, lineIndexMap])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <Button variant="ghost" size="icon" onClick={onBack} className="h-6 w-6">
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <p className="min-w-0 flex-1 truncate text-[length:var(--fd-text-xs)] font-medium text-fg-primary">
          {filePath}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center p-8">
            <LoaderCircle className="h-5 w-5 animate-spin text-fg-faint" />
          </div>
        ) : error ? (
          <div className="p-4 text-center text-[length:var(--fd-text-xs)] text-danger">{error}</div>
        ) : parsed === 'too-large' ? (
          <div className="p-4 text-center text-[length:var(--fd-text-xs)] text-fg-muted">
            Diff too large to display
          </div>
        ) : parsed && parsed.length > 0 ? (
          <div className="font-mono text-[length:var(--fd-text-2xs)] leading-5">
            {(() => {
              let globalIndex = 0
              return parsed.map((file, fi) =>
                file.chunks.map((chunk, ci) => (
                  <div key={`${fi}-${ci}`}>
                    <div className="sticky left-0 border-y border-border-subtle bg-surface-2 px-2 py-0.5 text-fg-muted">
                      {chunk.content}
                    </div>
                    {chunk.changes.map((change, li) => {
                      const idx = globalIndex++
                      return (
                        <HighlightedDiffLine
                          key={`${fi}-${ci}-${li}`}
                          change={change}
                          tokens={tokenMap?.get(idx) ?? null}
                        />
                      )
                    })}
                  </div>
                )),
              )
            })()}
          </div>
        ) : (
          <div className="p-4 text-center text-[length:var(--fd-text-xs)] text-fg-muted">
            {diff === '' ? 'No diff available (file may be untracked)' : 'No changes to display'}
          </div>
        )}
      </div>
    </div>
  )
})
