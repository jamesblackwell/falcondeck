import { describe, expect, it } from 'vitest'

import {
  decodeFileUrl,
  parseLocalFilePath,
  splitLocalPathSegments,
} from './local-path'

describe('parseLocalFilePath', () => {
  it('accepts macOS and Unix absolute paths', () => {
    expect(
      parseLocalFilePath(
        '/Users/James/www/sites/lucidpic/storage/app/training-artifacts/dani-wan-t2v-poc-20260822/tailscale/v2/',
      ),
    ).toBe(
      '/Users/James/www/sites/lucidpic/storage/app/training-artifacts/dani-wan-t2v-poc-20260822/tailscale/v2/',
    )
    expect(parseLocalFilePath('/tmp/kitchen.mp4')).toBe('/tmp/kitchen.mp4')
    expect(parseLocalFilePath('/home/james/notes.md')).toBe('/home/james/notes.md')
    expect(parseLocalFilePath('~/Desktop/clip.mp4')).toBe('~/Desktop/clip.mp4')
  })

  it('unwraps quotes and trailing punctuation', () => {
    expect(parseLocalFilePath('"/Users/James/clip.mp4"')).toBe(
      '/Users/James/clip.mp4',
    )
    expect(parseLocalFilePath('/Users/qa/notes.md.')).toBe('/Users/qa/notes.md')
    expect(parseLocalFilePath('/tmp/out/')).toBe('/tmp/out/')
  })

  it('decodes local file URLs', () => {
    expect(parseLocalFilePath('file:///Users/James/My%20File.mp4')).toBe(
      '/Users/James/My File.mp4',
    )
    expect(parseLocalFilePath('file://localhost/Users/James/clip.mp4')).toBe(
      '/Users/James/clip.mp4',
    )
  })

  it('rejects web routes, relative files, and empty tokens', () => {
    expect(parseLocalFilePath('/api/provider')).toBeNull()
    expect(parseLocalFilePath('/docs/getting-started')).toBeNull()
    expect(parseLocalFilePath('src/App.tsx')).toBeNull()
    expect(parseLocalFilePath('kitchen.mp4')).toBeNull()
    expect(parseLocalFilePath('/tmpfoo')).toBeNull()
    expect(parseLocalFilePath('')).toBeNull()
    expect(parseLocalFilePath('~')).toBeNull()
  })

  it('rejects control characters', () => {
    expect(parseLocalFilePath('/Users/James/clip\u0000.mp4')).toBeNull()
  })
})

describe('decodeFileUrl', () => {
  it('rejects remote file hosts', () => {
    expect(decodeFileUrl('file://evil.example/Users/foo')).toBeNull()
  })

  it('strips the extra slash on Windows drive URLs', () => {
    expect(decodeFileUrl('file:///C:/Users/James/clip.mp4')).toBe(
      'C:/Users/James/clip.mp4',
    )
  })
})

describe('splitLocalPathSegments', () => {
  it('extracts known roots and leaves web routes alone', () => {
    expect(
      splitLocalPathSegments(
        'see /Users/qa/notes.md and /api/provider then ~/Desktop/a.mp4.',
      ),
    ).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'path', value: '/Users/qa/notes.md' },
      { kind: 'text', value: ' and /api/provider then ' },
      { kind: 'path', value: '~/Desktop/a.mp4' },
      { kind: 'text', value: '.' },
    ])
  })

  it('does not treat /Users inside an https URL as a path', () => {
    expect(
      splitLocalPathSegments('see https://example.com/Users/foo today'),
    ).toEqual([
      { kind: 'text', value: 'see https://example.com/Users/foo today' },
    ])
  })

  it('returns a single text segment when nothing matches', () => {
    expect(splitLocalPathSegments('no paths here')).toEqual([
      { kind: 'text', value: 'no paths here' },
    ])
  })
})
