import { describe, expect, it } from 'vitest'

import { findFileLinks, resolveTerminalPath } from './terminal-links'

const paths = (line: string) => findFileLinks(line).map((link) => [link.path, link.line, link.column])

describe('terminal file links', () => {
  it('finds compiler-style locations', () => {
    expect(paths('error: src/app.ts:12:4 - Type mismatch')).toEqual([['src/app.ts', 12, 4]])
    expect(paths('  --> crates/core/src/lib.rs:88:5')).toEqual([['crates/core/src/lib.rs', 88, 5]])
    expect(paths('main.rs:3: warning')).toEqual([['main.rs', 3, null]])
    expect(paths('see ./docs/terminal.md.')).toEqual([['./docs/terminal.md', null, null]])
    expect(paths('open /Users/me/x/y.json')).toEqual([['/Users/me/x/y.json', null, null]])
  })

  it('leaves prose, versions and URLs alone', () => {
    expect(paths('this and/or that')).toEqual([])
    expect(paths('node v22.1.0 ready')).toEqual([])
    expect(paths('package.json')).toEqual([])
    expect(paths('visit https://example.com/a/b.html now')).toEqual([])
  })

  it('reports the matched columns', () => {
    const [link] = findFileLinks('at src/a.ts:3')
    expect(link).toMatchObject({ start: 3, text: 'src/a.ts:3' })
  })

  it('resolves against the pane directory', () => {
    expect(resolveTerminalPath('src/a.ts', '/repo/apps')).toBe('/repo/apps/src/a.ts')
    expect(resolveTerminalPath('../b.ts', '/repo/apps/')).toBe('/repo/b.ts')
    expect(resolveTerminalPath('/abs/c.ts', '/repo')).toBe('/abs/c.ts')
    expect(resolveTerminalPath('~/d.ts', '/repo', '/Users/me')).toBe('/Users/me/d.ts')
  })
})
