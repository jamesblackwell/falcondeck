import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FilePreviewMeta } from '@falcondeck/client-core'

import { absolutePathForActions } from '../local-file-links'
import { FilePreviewDialog } from './FilePreviewDialog'

vi.mock('@falcondeck/chat-ui', () => ({
  MessageMarkdown: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>,
  HighlightedFileLine: ({ text }: { text: string }) => <div data-testid="code-line">{text}</div>,
  languageFromPath: () => 'text',
  useShikiTokens: () => null,
  revealInFolderLabel: () => 'Reveal in Finder',
}))
vi.mock('./diff/media-file', () => ({
  MediaFilePreview: ({ kind, src, fileName }: { kind: string; src: string; fileName: string }) => (
    <div data-testid="media" data-kind={kind} data-src={src}>
      {fileName}
    </div>
  ),
}))

function meta(overrides: Partial<FilePreviewMeta> = {}): FilePreviewMeta {
  return {
    path: '/tmp/out/report.md',
    name: 'report.md',
    size_bytes: 1200,
    modified_ms: 1,
    version: '1:1200',
    content_type: 'text/markdown',
    kind: 'markdown',
    max_range_bytes: 262144,
    ...overrides,
  }
}

const textBlob = (text: string, type = 'text/plain') =>
  ({ type, text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer }) as unknown as Blob

function setup(options: { meta?: FilePreviewMeta; body?: string; statError?: Error; readError?: Error } = {}) {
  const api = {
    statFile: vi.fn(async () => {
      if (options.statError) throw options.statError
      return options.meta ?? meta()
    }),
    readFile: vi.fn(async () => {
      if (options.readError) throw options.readError
      return { blob: textBlob(options.body ?? '# Heading'), version: null }
    }),
  }
  const onClose = vi.fn()
  const onReveal = vi.fn(async () => undefined)
  const onOpenDefault = vi.fn(async () => undefined)
  const view = render(
    <FilePreviewDialog
      target={{ path: '/tmp/out/report.md', workspaceId: 'w1', threadId: 't1' }}
      api={api}
      onClose={onClose}
      onReveal={onReveal}
      onOpenDefault={onOpenDefault}
    />,
  )
  return { api, onClose, onReveal, onOpenDefault, ...view }
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:fake')
  URL.revokeObjectURL = vi.fn()
})
afterEach(cleanup)

describe('FilePreviewDialog', () => {
  it('asks the daemon with the thread context and renders markdown', async () => {
    const { api } = setup()
    expect(await screen.findByTestId('markdown')).toHaveTextContent('# Heading')
    expect(api.statFile).toHaveBeenCalledWith({ path: '/tmp/out/report.md', workspace_id: 'w1', thread_id: 't1' })
    // The read uses the canonical path the daemon reported.
    expect(api.readFile).toHaveBeenCalledWith({ path: '/tmp/out/report.md', workspace_id: 'w1', thread_id: 't1' })
    expect(screen.getByRole('dialog', { name: 'report.md' })).toBeInTheDocument()
  })

  it('shows HTML in a frame with no scripts, no same-origin and a no-network policy', async () => {
    setup({ meta: meta({ name: 'dash.html', path: '/tmp/dash.html', kind: 'html' }), body: '<h1>Dash</h1><script>alert(1)</script>' })
    const frame = (await screen.findByTitle('Preview of dash.html')) as HTMLIFrameElement
    expect(frame.getAttribute('sandbox')).toBe('')
    const doc = frame.getAttribute('srcdoc') ?? ''
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<h1>'))
    expect(doc).toContain("default-src 'none'")
  })

  it('offers a source view for HTML instead of running it', async () => {
    setup({ meta: meta({ name: 'dash.html', path: '/tmp/dash.html', kind: 'html' }), body: '<h1>Dash</h1>' })
    await screen.findByTitle('Preview of dash.html')
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    expect(screen.queryByTitle('Preview of dash.html')).toBeNull()
    expect(screen.getByTestId('code-line')).toHaveTextContent('<h1>Dash</h1>')
  })

  it('previews images from an object URL and revokes it on close', async () => {
    const { unmount } = setup({ meta: meta({ name: 'shot.png', path: '/tmp/shot.png', kind: 'image', content_type: 'image/png' }) })
    const media = await screen.findByTestId('media')
    expect(media).toHaveAttribute('data-kind', 'image')
    expect(media).toHaveAttribute('data-src', 'blob:fake')
    unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake')
  })

  it('hands a PDF to the viewer as bytes', async () => {
    setup({ meta: meta({ name: 'a.pdf', path: '/tmp/a.pdf', kind: 'pdf' }), body: '%PDF-1.7' })
    expect(await screen.findByTestId('media')).toHaveAttribute('data-kind', 'pdf')
  })

  it('shows text and code line by line', async () => {
    setup({ meta: meta({ name: 'a.ts', path: '/tmp/a.ts', kind: 'code' }), body: 'const a = 1\nconst b = 2' })
    await waitFor(() => expect(screen.getAllByTestId('code-line')).toHaveLength(2))
  })

  it('does not read a binary file; it offers Reveal and Open instead', async () => {
    const { api, onReveal, onOpenDefault } = setup({ meta: meta({ name: 'x.bin', path: '/tmp/x.bin', kind: 'binary' }) })
    expect(await screen.findByText('This file can’t be previewed')).toBeInTheDocument()
    expect(api.readFile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Reveal in Finder/ }))
    expect(onReveal).toHaveBeenCalledWith('/tmp/x.bin')
    fireEvent.click(screen.getByRole('button', { name: /Open in default app/ }))
    expect(onOpenDefault).toHaveBeenCalledWith('/tmp/x.bin')
  })

  it('falls back to Reveal and Open, with the denial reason, when the daemon denies the file', async () => {
    const { api, onReveal, onOpenDefault } = setup({
      statError: new Error("file_denied: This file isn't shareable from your Mac."),
    })
    expect(await screen.findByText('FalconDeck can’t show this file')).toBeInTheDocument()
    expect(screen.getByText("This file isn't shareable from your Mac.")).toBeInTheDocument()
    expect(screen.getByText('file_denied')).toBeInTheDocument()
    expect(api.readFile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Reveal in Finder/ }))
    expect(onReveal).toHaveBeenCalledWith('/tmp/out/report.md')
    fireEvent.click(screen.getByRole('button', { name: /Open in default app/ }))
    expect(onOpenDefault).toHaveBeenCalledWith('/tmp/out/report.md')
  })

  it('treats a failed read like a denial', async () => {
    setup({ readError: new Error('file_changed: The file changed while it was being read.') })
    expect(await screen.findByText('This file couldn’t be loaded')).toBeInTheDocument()
    expect(screen.getByText('The file changed while it was being read.')).toBeInTheDocument()
  })

  it('reports an action that fails, without closing', async () => {
    const { onReveal } = setup({ statError: new Error('file_not_found: This file no longer exists on your Mac.') })
    onReveal.mockRejectedValueOnce(new Error('No such file'))
    await screen.findByText('This file couldn’t be loaded')
    fireEvent.click(screen.getByRole('button', { name: /Reveal in Finder/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No such file')
  })

  it('closes on Escape and from the close button', async () => {
    const { onClose } = setup()
    await screen.findByTestId('markdown')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('without a daemon connection it still offers the OS actions', async () => {
    const onReveal = vi.fn(async () => undefined)
    render(<FilePreviewDialog target={{ path: '/tmp/a.md' }} api={null} onClose={() => {}} onReveal={onReveal} />)
    expect(await screen.findByText(/isn’t connected/)).toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Reveal in Finder/ })))
    expect(onReveal).toHaveBeenCalledWith('/tmp/a.md')
  })
})

describe('absolutePathForActions', () => {
  it('prefers the canonical path, then an absolute link, then base_dir + relative', () => {
    expect(absolutePathForActions({ path: 'x.md' }, { path: '/real/x.md' })).toBe('/real/x.md')
    expect(absolutePathForActions({ path: 'file:///tmp/x.md' }, null)).toBe('file:///tmp/x.md')
    expect(absolutePathForActions({ path: '~/x.md' }, null)).toBe('~/x.md')
    expect(absolutePathForActions({ path: './img/x.png', baseDir: '/docs/' }, null)).toBe('/docs/img/x.png')
    expect(absolutePathForActions({ path: 'x.md' }, null)).toBeNull()
  })
})
