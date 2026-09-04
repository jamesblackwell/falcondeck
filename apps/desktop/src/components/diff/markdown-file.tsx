import { useEffect, useState } from 'react'

import { MessageMarkdown } from '@falcondeck/chat-ui'
import { cn } from '@falcondeck/ui'

import { isMarkdownFilePath } from './diff-utils'

export type FilePreviewMode = 'preview' | 'source'

/** Same budget as DiffView's whole-file source cap. */
export const MAX_MARKDOWN_PREVIEW_CHARS = 200_000

export function shouldPreviewMarkdown(path: string, text: string | null | undefined) {
  return (
    text != null &&
    isMarkdownFilePath(path) &&
    text.length <= MAX_MARKDOWN_PREVIEW_CHARS
  )
}

export function useMarkdownPreviewMode(filePath: string, enabled: boolean) {
  const [mode, setMode] = useState<FilePreviewMode>('preview')
  useEffect(() => {
    setMode('preview')
  }, [filePath])
  return {
    mode,
    setMode,
    showPreview: enabled && mode === 'preview',
  }
}

export function FilePreviewToggle({
  mode,
  onChange,
}: {
  mode: FilePreviewMode
  onChange: (mode: FilePreviewMode) => void
}) {
  return (
    <div
      role="group"
      aria-label="File display"
      className="flex shrink-0 rounded-[var(--fd-radius-sm)] border border-border-subtle p-0.5"
    >
      {([
        { value: 'preview', label: 'Preview' },
        { value: 'source', label: 'Source' },
      ] as const).map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={mode === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'fd-focus rounded-[calc(var(--fd-radius-sm)-1px)] px-2 py-0.5 text-[length:var(--fd-text-2xs)] font-medium',
            mode === option.value
              ? 'bg-surface-3 text-fg-primary'
              : 'text-fg-muted hover:text-fg-secondary',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function MarkdownFileDocument({ text }: { text: string }) {
  return (
    <div className="px-4 py-3">
      <MessageMarkdown text={text} defer={false} interpretDirectives={false} />
    </div>
  )
}
