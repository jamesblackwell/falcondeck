import { describe, expect, it } from 'vitest'

import { MAX_MARKDOWN_PREVIEW_CHARS, shouldPreviewMarkdown } from './markdown-file'

describe('shouldPreviewMarkdown', () => {
  it('allows markdown under the preview budget', () => {
    expect(shouldPreviewMarkdown('docs/notes.md', '# Hi\n')).toBe(true)
    expect(shouldPreviewMarkdown('page.mdx', 'hello')).toBe(true)
  })

  it('refuses source files, empty payloads, and oversized documents', () => {
    expect(shouldPreviewMarkdown('src/App.tsx', '# Hi\n')).toBe(false)
    expect(shouldPreviewMarkdown('notes.md', null)).toBe(false)
    expect(
      shouldPreviewMarkdown('notes.md', 'x'.repeat(MAX_MARKDOWN_PREVIEW_CHARS + 1)),
    ).toBe(false)
  })
})
