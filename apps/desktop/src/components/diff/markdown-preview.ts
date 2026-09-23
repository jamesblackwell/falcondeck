import { useEffect, useState } from 'react'

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
