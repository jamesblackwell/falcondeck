import { describe, expect, it } from 'vitest'

import {
  HTML_PREVIEW_CSP,
  fileRequestFor,
  htmlPreviewDocument,
  localFileFromHref,
  parseFileFailure,
  previewSurfaceFor,
} from './local-file-links'

describe('localFileFromHref', () => {
  it('claims file:// URLs, ~/ paths and absolute paths under a known root', () => {
    expect(localFileFromHref('file:///Users/me/report.md')).toBe('/Users/me/report.md')
    expect(localFileFromHref('file://localhost/tmp/a%20b.html#top')).toBe('/tmp/a b.html')
    expect(localFileFromHref('~/Desktop/shot.png')).toBe('~/Desktop/shot.png')
    expect(localFileFromHref('/Users/me/out/report.md#section')).toBe('/Users/me/out/report.md')
    expect(localFileFromHref('/tmp/My%20Report.pdf')).toBe('/tmp/My Report.pdf')
  })

  it('leaves web links, app routes, anchors and prose-like relative paths alone', () => {
    for (const href of [
      'https://example.com/Users/me/a.md',
      'http://localhost:5173/',
      'mailto:a@b.co',
      'javascript:alert(1)',
      '#section',
      '/settings',
      'src/app.ts',
      './README.md',
      '',
      null,
      undefined,
    ]) {
      expect(localFileFromHref(href)).toBeNull()
    }
  })

  it('rejects file URLs for another host', () => {
    expect(localFileFromHref('file://evil.example/Users/me/a.md')).toBeNull()
  })
})

describe('previewSurfaceFor', () => {
  it('picks a viewer per kind', () => {
    const size_bytes = 1000
    expect(previewSurfaceFor({ kind: 'markdown', size_bytes })).toBe('markdown')
    expect(previewSurfaceFor({ kind: 'html', size_bytes })).toBe('html')
    expect(previewSurfaceFor({ kind: 'image', size_bytes })).toBe('image')
    expect(previewSurfaceFor({ kind: 'pdf', size_bytes })).toBe('pdf')
    expect(previewSurfaceFor({ kind: 'code', size_bytes })).toBe('code')
    expect(previewSurfaceFor({ kind: 'text', size_bytes })).toBe('text')
    expect(previewSurfaceFor({ kind: 'video', size_bytes })).toBe('video')
    expect(previewSurfaceFor({ kind: 'audio', size_bytes })).toBe('audio')
  })

  it('refuses binaries and oversized files rather than loading them', () => {
    expect(previewSurfaceFor({ kind: 'binary', size_bytes: 10 })).toBe('unsupported')
    expect(previewSurfaceFor({ kind: 'text', size_bytes: 3_000_000 })).toBe('too_large')
    expect(previewSurfaceFor({ kind: 'pdf', size_bytes: 26_000_000 })).toBe('too_large')
    expect(previewSurfaceFor({ kind: 'image', size_bytes: 20_000_000 })).toBe('image')
  })
})

describe('parseFileFailure', () => {
  it('splits the stable code from the reason', () => {
    expect(parseFileFailure(new Error("file_denied: This file isn't shareable from your Mac."))).toEqual({
      code: 'file_denied',
      reason: "This file isn't shareable from your Mac.",
    })
    expect(parseFileFailure(new Error('file_not_found: This file no longer exists on your Mac.')).code).toBe(
      'file_not_found',
    )
  })

  it('keeps unknown errors whole', () => {
    expect(parseFileFailure(new Error('Request failed with status 500'))).toEqual({
      code: null,
      reason: 'Request failed with status 500',
    })
    expect(parseFileFailure(undefined).reason).toMatch(/could not be read/)
  })
})

describe('fileRequestFor', () => {
  it('passes thread and workspace so relative paths resolve against the working directory', () => {
    expect(fileRequestFor({ path: 'docs/a.md', workspaceId: 'w1', threadId: 't1' })).toEqual({
      path: 'docs/a.md',
      workspace_id: 'w1',
      thread_id: 't1',
    })
    expect(fileRequestFor({ path: '/tmp/a.md', baseDir: '/tmp' })).toEqual({
      path: '/tmp/a.md',
      base_dir: '/tmp',
    })
  })
})

describe('htmlPreviewDocument', () => {
  it('puts a no-network policy ahead of the document', () => {
    const html = htmlPreviewDocument('<img src="https://tracker.example/p.gif"><h1>Report</h1>')
    const policy = html.indexOf('Content-Security-Policy')
    expect(policy).toBeGreaterThan(-1)
    expect(policy).toBeLessThan(html.indexOf('tracker.example'))
    expect(HTML_PREVIEW_CSP).toContain("default-src 'none'")
    expect(HTML_PREVIEW_CSP).not.toMatch(/https?:/)
    expect(HTML_PREVIEW_CSP).not.toContain('script-src')
  })
})
