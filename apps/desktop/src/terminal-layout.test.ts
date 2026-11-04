import { describe, expect, it } from 'vitest'

import {
  adjacentPaneId,
  directionalPaneId,
  leaf,
  paneIds,
  paneRects,
  prunePanes,
  removePane,
  setSplitRatio,
  splitDividers,
  splitPane,
} from './terminal-layout'

// a | b
//   | c
const layout = () => splitPane(splitPane(leaf('a'), 'a', 'b', 'row'), 'b', 'c', 'column')

describe('terminal split layout', () => {
  it('splits the target pane and keeps reading order', () => {
    expect(paneIds(layout())).toEqual(['a', 'b', 'c'])
    const rects = paneRects(layout())
    expect(rects.get('a')).toEqual({ x: 0, y: 0, w: 0.5, h: 1 })
    expect(rects.get('b')).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 })
    expect(rects.get('c')).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
  })

  it('collapses a split when one side closes', () => {
    const root = removePane(layout(), 'b')!
    expect(paneIds(root)).toEqual(['a', 'c'])
    expect(paneRects(root).get('c')).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 })
    expect(removePane(leaf('a'), 'a')).toBeNull()
    expect(paneIds(prunePanes(layout(), new Set(['c']))!)).toEqual(['c'])
    expect(prunePanes(layout(), new Set())).toBeNull()
  })

  it('cycles panes in reading order', () => {
    expect(adjacentPaneId(layout(), 'c', 1)).toBe('a')
    expect(adjacentPaneId(layout(), 'a', -1)).toBe('c')
    expect(adjacentPaneId(leaf('a'), 'a', 1)).toBeNull()
  })

  it('finds the neighbour in a screen direction', () => {
    expect(directionalPaneId(layout(), 'a', 'right')).toBe('b')
    expect(directionalPaneId(layout(), 'c', 'left')).toBe('a')
    expect(directionalPaneId(layout(), 'b', 'down')).toBe('c')
    expect(directionalPaneId(layout(), 'c', 'up')).toBe('b')
    expect(directionalPaneId(layout(), 'a', 'left')).toBeNull()
    expect(directionalPaneId(layout(), 'a', 'up')).toBeNull()
  })

  it('clamps divider drags and reports divider geometry', () => {
    const root = layout()
    const [outer] = splitDividers(root)
    expect(outer).toMatchObject({ direction: 'row', ratio: 0.5 })
    const dragged = setSplitRatio(root, outer!.id, 0.99)
    expect(splitDividers(dragged)[0]!.ratio).toBe(0.9)
    expect(splitDividers(dragged)[1]!.rect).toEqual({ x: 0.9, y: 0, w: expect.closeTo(0.1, 6), h: 1 })
  })
})
