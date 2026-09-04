import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FileView } from './FileView'

function stubObjectUrls(url: string) {
  const createObjectURL = vi.fn(() => url)
  const revokeObjectURL = vi.fn()
  Object.assign(URL, { createObjectURL, revokeObjectURL })
  return { createObjectURL, revokeObjectURL }
}

describe('FileView', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

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

    expect(screen.getByText('1 line')).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Edit src/App.tsx' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit file' }))
    const editor = screen.getByRole('textbox', { name: 'Edit src/App.tsx' })
    fireEvent.change(editor, { target: { value: 'const value = 2' } })
    fireEvent.keyDown(editor, { key: 's', metaKey: true })
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('const value = 2'))
  })

  it('renders markdown by default and toggles to source', () => {
    render(
      <FileView
        filePath="docs/notes.md"
        file={{
          path: 'docs/notes.md',
          content: '# Audit\n\nAll good.',
          is_binary: false,
          truncated: false,
          version: 'v1',
        }}
        isLoading={false}
        isSaving={false}
        error={null}
        onBack={vi.fn()}
        onReload={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Audit' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('# Audit')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))

    expect(screen.getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('# Audit')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Audit' })).toBeNull()
  })

  it('renders an image instead of the binary placeholder', async () => {
    const { createObjectURL } = stubObjectUrls('blob:image')

    render(
      <FileView
        filePath="qa-artifacts/shot.png"
        file={{
          path: 'qa-artifacts/shot.png',
          content: null,
          is_binary: true,
          truncated: false,
          version: 'v1',
          content_base64: 'aaaa',
          mime_type: 'image/png',
        }}
        isLoading={false}
        isSaving={false}
        error={null}
        onBack={vi.fn()}
        onReload={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    expect(await screen.findByRole('img', { name: 'shot.png' })).toHaveAttribute('src', 'blob:image')
    expect(screen.queryByText("This file isn't previewable")).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit file' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByRole('button', { name: 'Fit to view' })).toHaveTextContent('115%')
    expect(createObjectURL).toHaveBeenCalled()
  })

  it('renders a video player for movie files', async () => {
    stubObjectUrls('blob:video')

    render(
      <FileView
        filePath="clips/demo.mp4"
        file={{
          path: 'clips/demo.mp4',
          content: null,
          is_binary: true,
          truncated: false,
          version: 'v1',
          content_base64: 'aaaa',
          mime_type: 'video/mp4',
        }}
        isLoading={false}
        isSaving={false}
        error={null}
        onBack={vi.fn()}
        onReload={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    expect(await screen.findByLabelText('Preview of demo.mp4')).toHaveAttribute('src', 'blob:video')
    expect(screen.queryByText("This file isn't previewable")).toBeNull()
  })

  it('names the media size limit for oversized images', () => {
    render(
      <FileView
        filePath="qa/huge.png"
        file={{
          path: 'qa/huge.png',
          content: null,
          is_binary: false,
          truncated: true,
          version: 'v1',
          mime_type: 'image/png',
        }}
        isLoading={false}
        isSaving={false}
        error={null}
        onBack={vi.fn()}
        onReload={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    expect(screen.getByText('This file is too large to preview')).toBeVisible()
    expect(screen.getByText('16 MB limit')).toBeVisible()
  })

  it('keeps unknown binaries as a placeholder', () => {
    render(
      <FileView
        filePath="vendor/blob.bin"
        file={{
          path: 'vendor/blob.bin',
          content: null,
          is_binary: true,
          truncated: false,
          version: 'v1',
        }}
        isLoading={false}
        isSaving={false}
        error={null}
        onBack={vi.fn()}
        onReload={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    expect(screen.getByText("This file isn't previewable")).toBeVisible()
    expect(screen.getAllByText('blob.bin').length).toBeGreaterThan(0)
  })

  it('copies the workspace-relative path', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    render(
      <FileView
        filePath="qa-artifacts/shot.png"
        file={{
          path: 'qa-artifacts/shot.png',
          content: null,
          is_binary: true,
          truncated: false,
          version: 'v1',
        }}
        isLoading={false}
        isSaving={false}
        error={null}
        onBack={vi.fn()}
        onReload={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy path' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('qa-artifacts/shot.png'))
  })

  it('previews SVG as an image and toggles to source', async () => {
    stubObjectUrls('blob:svg')

    render(
      <FileView
        filePath="assets/logo.svg"
        file={{
          path: 'assets/logo.svg',
          content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
          is_binary: false,
          truncated: false,
          version: 'v1',
          mime_type: 'image/svg+xml',
        }}
        isLoading={false}
        isSaving={false}
        error={null}
        onBack={vi.fn()}
        onReload={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    expect(await screen.findByRole('img', { name: 'logo.svg' })).toHaveAttribute('src', 'blob:svg')
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    expect(screen.getByText('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBeVisible()
  })
})
