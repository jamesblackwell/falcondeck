import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { DiffView } from './DiffView'

const MARKDOWN_DIFF =
  'diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-old\n+new\n'

describe('DiffView', () => {
  it('renders markdown by default and toggles to the diff', () => {
    render(
      <DiffView
        filePath="notes.md"
        diff={MARKDOWN_DIFF}
        content={'# Hello\n\nBody'}
        isLoading={false}
        error={null}
        onBack={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Hello' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))

    expect(screen.getByText('new')).toBeVisible()
    expect(screen.getByText('old')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Hello' })).toBeNull()
  })

  it('shows whole-file contents when git has no diff', () => {
    render(
      <DiffView
        filePath="src/new.ts"
        diff=""
        content="export const value = 1"
        isLoading={false}
        error={null}
        onBack={vi.fn()}
      />,
    )

    expect(screen.getByText('export const value = 1')).toBeVisible()
    expect(screen.queryByText('Unable to load this file')).toBeNull()
  })
})
