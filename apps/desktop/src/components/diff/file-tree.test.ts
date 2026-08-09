import { describe, expect, it } from 'vitest'

import { buildFileTree, directoryPathsForMatches } from './file-tree'

describe('buildFileTree', () => {
  it('sorts directories before files and nests shared paths', () => {
    const tree = buildFileTree(['README.md', 'src/z.ts', 'src/a.ts'])
    expect(tree.map((node) => node.path)).toEqual(['src', 'README.md'])
    expect(tree[0]?.children.map((node) => node.path)).toEqual(['src/a.ts', 'src/z.ts'])
  })

  it('finds every parent directory for filtered paths', () => {
    expect([...directoryPathsForMatches(['src/components/App.tsx'])]).toEqual([
      'src',
      'src/components',
    ])
  })
})
