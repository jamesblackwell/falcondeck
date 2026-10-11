import { describe, expect, it } from 'vitest'

import { buildFileTree, directoryPathsForMatches } from './file-tree'

describe('buildFileTree', () => {
  it('sorts directories before files and nests shared paths', () => {
    const tree = buildFileTree(['README.md', 'src/z.ts', 'src/a.ts'])
    expect(tree.map((node) => node.path)).toEqual(['src', 'README.md'])
    expect(tree[0]?.children.map((node) => node.path)).toEqual(['src/a.ts', 'src/z.ts'])
  })

  it('promotes a listed path to a directory once a nested file appears', () => {
    const expected = [
      {
        name: 'src',
        path: 'src',
        kind: 'directory',
        children: [{ name: 'a.ts', path: 'src/a.ts', kind: 'file', children: [] }],
      },
    ]
    expect(buildFileTree(['src', 'src/a.ts'])).toEqual(expected)
    expect(buildFileTree(['src/a.ts', 'src'])).toEqual(expected)
  })

  it('finds every parent directory for filtered paths', () => {
    expect([...directoryPathsForMatches(['src/components/App.tsx'])]).toEqual([
      'src',
      'src/components',
    ])
  })
})
