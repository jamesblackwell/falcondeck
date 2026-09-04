import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { FileView } from './FileView'

describe('FileView', () => {
  it('scrolls to and highlights the cited line', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render(
      <FileView
        filePath="src/app.ts"
        line={2}
        file={{
          path: 'src/app.ts',
          content: 'one\ntwo\nthree',
          is_binary: false,
          truncated: false,
          version: '1',
        }}
        isLoading={false}
        isSaving={false}
        error={null}
        onBack={vi.fn()}
        onReload={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    const row = screen.getByText('two').closest('[data-line]')
    expect(row?.getAttribute('data-line')).toBe('2')
    expect(row?.className).toContain('bg-accent/10')
    expect(screen.getByText('one').closest('[data-line]')?.className).not.toContain('bg-accent/10')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
  })

  it('calls back when the preview arrow is clicked', () => {
    const onBack = vi.fn()
    render(
      <FileView
        filePath="README.md"
        file={null}
        isLoading={false}
        isSaving={false}
        error={null}
        onBack={onBack}
        onReload={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Back to files' }))

    expect(onBack).toHaveBeenCalledOnce()
  })

  it('keeps files read-only until edit and saves the replacement', async () => {
    const onSave = vi.fn().mockResolvedValue(true)
    render(
      <FileView
        filePath="src/App.tsx"
        file={{
          path: 'src/App.tsx',
          content: 'const value = 1',
          is_binary: false,
          truncated: false,
          version: 'v1',
        }}
        isLoading={false}
        isSaving={false}
        error={null}
        onBack={vi.fn()}
        onReload={vi.fn()}
        onSave={onSave}
      />,
    )

    expect(screen.queryByRole('textbox', { name: 'Edit src/App.tsx' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit file' }))
    const editor = screen.getByRole('textbox', { name: 'Edit src/App.tsx' })
    fireEvent.change(editor, { target: { value: 'const value = 2' } })
    fireEvent.keyDown(editor, { key: 's', metaKey: true })
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('const value = 2'))
  })
})
