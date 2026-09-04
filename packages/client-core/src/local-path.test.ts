import { describe, expect, it } from 'vitest'

import {
  decodeFileUrl,
  looksLikeWorkspaceFileReference,
  parseLocalFilePath,
  parseWorkspaceFilePath,
  parseWorkspaceFileReference,
  splitLocalPathSegments,
  workspaceFileReferenceFromLocalPath,
  workspaceRelativeFilePath,
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

  it('treats localhost names case-insensitively', () => {
    expect(decodeFileUrl('file://LOCALHOST/Users/James/clip.mp4')).toBe(
      '/Users/James/clip.mp4',
    )
  })

  it('strips the extra slash on Windows drive URLs', () => {
    expect(decodeFileUrl('file:///C:/Users/James/clip.mp4')).toBe(
      'C:/Users/James/clip.mp4',
    )
  })
})

describe('parseWorkspaceFilePath', () => {
  it('normalizes safe workspace-relative file links', () => {
    expect(parseWorkspaceFilePath('bootstrap/studio-ui/init.py')).toBe(
      'bootstrap/studio-ui/init.py',
    )
    expect(parseWorkspaceFilePath('./src/My%20File.tsx#L42')).toBe(
      'src/My File.tsx',
    )
    expect(parseWorkspaceFilePath('src/App.tsx:518:9')).toBe('src/App.tsx')
    expect(parseWorkspaceFilePath('README.md:12')).toBe('README.md')
  })

  it('rejects absolute paths, URLs, and paths that escape the workspace', () => {
    expect(parseWorkspaceFilePath('/Users/James/project/src/App.tsx')).toBeNull()
    expect(parseWorkspaceFilePath('file:///workspace/src/App.tsx')).toBeNull()
    expect(parseWorkspaceFilePath('https://example.com/file.ts')).toBeNull()
    expect(parseWorkspaceFilePath('#installation')).toBeNull()
    expect(parseWorkspaceFilePath('%2FUsers%2FJames%2Ffile.ts')).toBeNull()
    expect(parseWorkspaceFilePath('src/file.ts%00')).toBeNull()
    expect(parseWorkspaceFilePath('../outside.ts')).toBeNull()
    expect(parseWorkspaceFilePath('src/../../outside.ts')).toBeNull()
  })
})

describe('workspaceRelativeFilePath', () => {
  const root = '/Users/James/www/sites/quizgecko'

  it('keeps already-relative workspace paths', () => {
    expect(workspaceRelativeFilePath('docs/qa/notes.md', root)).toBe(
      'docs/qa/notes.md',
    )
    expect(workspaceRelativeFilePath('./src/App.tsx', root)).toBe('src/App.tsx')
  })

  it('strips the workspace root from an absolute path inside it', () => {
    expect(
      workspaceRelativeFilePath(`${root}/docs/qa/2026-09-mobile-ux-audit.md`, root),
    ).toBe('docs/qa/2026-09-mobile-ux-audit.md')
    expect(
      workspaceRelativeFilePath(`${root}/`, root),
    ).toBe(`${root}/`)
  })

  it('leaves absolute paths outside the workspace alone', () => {
    expect(
      workspaceRelativeFilePath('/Users/James/www/sites/other/README.md', root),
    ).toBe('/Users/James/www/sites/other/README.md')
  })

  it('returns the original path when no workspace root is known', () => {
    expect(
      workspaceRelativeFilePath('/Users/James/www/sites/quizgecko/README.md', null),
    ).toBe('/Users/James/www/sites/quizgecko/README.md')
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

describe('parseWorkspaceFileReference', () => {
  it('keeps the first line of every citation form', () => {
    expect(parseWorkspaceFileReference('src/app.ts:12')).toEqual({ path: 'src/app.ts', line: 12 })
    expect(parseWorkspaceFileReference('src/app.ts:12:4')).toEqual({ path: 'src/app.ts', line: 12 })
    expect(parseWorkspaceFileReference('src/app.ts:12-20')).toEqual({ path: 'src/app.ts', line: 12 })
    expect(parseWorkspaceFileReference('./src/app.ts#L12-L20')).toEqual({ path: 'src/app.ts', line: 12 })
    expect(parseWorkspaceFileReference('README.md')).toEqual({ path: 'README.md', line: null })
  })

  it('rejects absolute paths and traversal', () => {
    expect(parseWorkspaceFileReference('/etc/passwd')).toBeNull()
    expect(parseWorkspaceFileReference('../secret.txt:3')).toBeNull()
  })
})

describe('looksLikeWorkspaceFileReference', () => {
  it('accepts relative paths and file names with extensions', () => {
    expect(looksLikeWorkspaceFileReference('apps/desktop/src/App.tsx:1150')).toBe(true)
    expect(looksLikeWorkspaceFileReference('./README.md')).toBe(true)
    expect(looksLikeWorkspaceFileReference('vite.config.ts')).toBe(true)
    expect(looksLikeWorkspaceFileReference('Makefile')).toBe(false)
  })

  it('rejects code, identifiers, URLs and absolute paths', () => {
    expect(looksLikeWorkspaceFileReference('process.env.HOME')).toBe(false)
    expect(looksLikeWorkspaceFileReference('foo.bar()')).toBe(false)
    expect(looksLikeWorkspaceFileReference('@falcondeck/ui')).toBe(false)
    expect(looksLikeWorkspaceFileReference('--no-verify')).toBe(false)
    expect(looksLikeWorkspaceFileReference('https://example.com/a.ts')).toBe(false)
    expect(looksLikeWorkspaceFileReference('/Users/qa/a.ts')).toBe(false)
    expect(looksLikeWorkspaceFileReference('git commit -m "x"')).toBe(false)
  })
})

describe('workspaceFileReferenceFromLocalPath', () => {
  it('maps an absolute path under the root to a reference with its line', () => {
    expect(
      workspaceFileReferenceFromLocalPath('/Users/qa/repo/src/app.ts:12', '/Users/qa/repo/'),
    ).toEqual({ path: 'src/app.ts', line: 12 })
  })

  it('returns null outside the root, at the root, or without a root', () => {
    expect(workspaceFileReferenceFromLocalPath('/Users/qa/other/a.ts', '/Users/qa/repo')).toBeNull()
    expect(workspaceFileReferenceFromLocalPath('/Users/qa/repo', '/Users/qa/repo')).toBeNull()
    expect(workspaceFileReferenceFromLocalPath('/Users/qa/repo/a.ts', null)).toBeNull()
  })
})
