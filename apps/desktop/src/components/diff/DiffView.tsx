import { memo, useMemo } from 'react'
import { ArrowLeft, ChevronDown, ChevronUp, FileCode2 } from 'lucide-react'

import {
  buildDiffFileRows,
  DiffFileSection,
  HighlightedFileLine,
  languageFromPath,
  parseUnifiedDiff,
  useShikiTokens,
} from '@falcondeck/chat-ui'
import { ActivityDiamond, Button } from '@falcondeck/ui'

export type DiffViewProps = {
  filePath: string
  diff: string | null
  content: string | null
  isLoading: boolean
  error: string | null
  onBack: () => void
  onOpenFile?: (() => void) | null
  onPrevious?: (() => void) | null
  onNext?: (() => void) | null
}

export const DiffView = memo(function DiffView({
  filePath,
  diff,
  content,
  isLoading,
  error,
  onBack,
  onOpenFile = null,
  onPrevious = null,
  onNext = null,
}: DiffViewProps) {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff])
  const fileRows = useMemo(
    () => (parsed.status === 'ok' ? buildDiffFileRows(parsed.files) : []),
    [parsed],
  )

  const fileLines = useMemo(() => {
    if (content === null) return [] as string[]
    return content.replace(/\r\n/g, '\n').split('\n')
  }, [content])

  // Whole-file view only; the diff path highlights per file inside DiffFileSection.
  const showWholeFile = parsed.status !== 'ok' && content !== null
  const fileLanguage = useMemo(() => languageFromPath(filePath), [filePath])
  const fileTokens = useShikiTokens(showWholeFile ? fileLines : [], fileLanguage)

  const isDisplayTooLarge =
    parsed.status === 'too-large' ||
    (parsed.status !== 'ok' && content !== null && content.length > 200_000)

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onBack}
          aria-label="Back to changed files"
          className="-ml-1 shrink-0"
        >
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
        </Button>
        <p className="min-w-0 flex-1 truncate text-[length:var(--fd-text-xs)] font-medium text-fg-primary">
          {filePath}
        </p>
        {onPrevious ? (
          <button type="button" onClick={onPrevious} aria-label="Previous changed file" className="fd-focus rounded-[var(--fd-radius-sm)] p-1 text-fg-muted hover:bg-surface-3 hover:text-fg-secondary">
            <ChevronUp aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {onNext ? (
          <button type="button" onClick={onNext} aria-label="Next changed file" className="fd-focus rounded-[var(--fd-radius-sm)] p-1 text-fg-muted hover:bg-surface-3 hover:text-fg-secondary">
            <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {onOpenFile ? (
          <button type="button" onClick={onOpenFile} aria-label="Open current file" className="fd-focus rounded-[var(--fd-radius-sm)] p-1 text-fg-muted hover:bg-surface-3 hover:text-fg-secondary">
            <FileCode2 aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center p-8">
            <ActivityDiamond size="lg" />
          </div>
        ) : error ? (
          <div className="p-4 text-center text-[length:var(--fd-text-xs)] text-danger">{error}</div>
        ) : isDisplayTooLarge ? (
          <div className="p-4 text-center text-[length:var(--fd-text-xs)] text-fg-muted">
            File too large to display
          </div>
        ) : fileRows.length > 0 ? (
          <div className="font-mono text-[length:var(--fd-text-2xs)] leading-5">
            {fileRows.map((file, index) => (
              <DiffFileSection key={file.path ?? index} path={file.path ?? filePath} rows={file.rows} />
            ))}
          </div>
        ) : content !== null ? (
          <div className="font-mono text-[length:var(--fd-text-2xs)] leading-5">
            {fileLines.map((line, index) => (
              <HighlightedFileLine
                key={index}
                lineNumber={index + 1}
                text={line}
                tokens={fileTokens?.[index] ?? null}
              />
            ))}
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
