import { memo, useMemo } from 'react'
import { ArrowLeft, LoaderCircle } from 'lucide-react'

import {
  buildDiffFileRows,
  DiffFileSection,
  HighlightedFileLine,
  languageFromPath,
  parseUnifiedDiff,
  useShikiTokens,
} from '@falcondeck/chat-ui'
import { Button } from '@falcondeck/ui'

export type DiffViewProps = {
  filePath: string
  diff: string | null
  content: string | null
  isLoading: boolean
  error: string | null
  onBack: () => void
}

export const DiffView = memo(function DiffView({
  filePath,
  diff,
  content,
  isLoading,
  error,
  onBack,
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
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 pb-2 pt-10">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          aria-label="Back to changed files"
          className="h-6 w-6"
        >
          <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
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
