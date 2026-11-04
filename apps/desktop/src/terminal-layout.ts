/**
 * Split layout for one terminal tab: a binary tree whose leaves are terminal
 * sessions. `row` puts children side by side (⌘D), `column` stacks them (⌘⇧D).
 */
export type PaneNode =
  | { type: 'pane'; id: string }
  | {
      type: 'split'
      id: string
      direction: 'row' | 'column'
      /** Share of the first child, 0–1. */
      ratio: number
      first: PaneNode
      second: PaneNode
    }

export type PaneDirection = 'left' | 'right' | 'up' | 'down'

const MIN_RATIO = 0.1
const MAX_RATIO = 0.9

export function leaf(id: string): PaneNode {
  return { type: 'pane', id }
}

/** Pane ids in reading order (left-to-right, top-to-bottom). */
export function paneIds(node: PaneNode): string[] {
  return node.type === 'pane' ? [node.id] : [...paneIds(node.first), ...paneIds(node.second)]
}

export function containsPane(node: PaneNode, id: string): boolean {
  return paneIds(node).includes(id)
}

/** Replaces `targetId` with a split holding it and `newId` (new pane second). */
export function splitPane(
  node: PaneNode,
  targetId: string,
  newId: string,
  direction: 'row' | 'column',
): PaneNode {
  if (node.type === 'pane') {
    if (node.id !== targetId) return node
    return {
      type: 'split',
      id: `split-${newId}`,
      direction,
      ratio: 0.5,
      first: node,
      second: leaf(newId),
    }
  }
  const first = splitPane(node.first, targetId, newId, direction)
  const second = first === node.first ? splitPane(node.second, targetId, newId, direction) : node.second
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/** Removes a pane; its sibling takes the parent split's place. Null when empty. */
export function removePane(node: PaneNode, id: string): PaneNode | null {
  if (node.type === 'pane') return node.id === id ? null : node
  const first = removePane(node.first, id)
  const second = removePane(node.second, id)
  if (!first) return second
  if (!second) return first
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/** Keeps only panes in `keep`; null when none survive. */
export function prunePanes(node: PaneNode, keep: ReadonlySet<string>): PaneNode | null {
  let next: PaneNode | null = node
  for (const id of paneIds(node)) {
    if (!keep.has(id) && next) next = removePane(next, id)
  }
  return next
}

export function setSplitRatio(node: PaneNode, splitId: string, ratio: number): PaneNode {
  if (node.type === 'pane') return node
  if (node.id === splitId) {
    return { ...node, ratio: Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)) }
  }
  const first = setSplitRatio(node.first, splitId, ratio)
  const second = setSplitRatio(node.second, splitId, ratio)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/** Next/previous pane in reading order, wrapping (⌘] / ⌘[). */
export function adjacentPaneId(node: PaneNode, id: string, offset: -1 | 1): string | null {
  const ids = paneIds(node)
  if (ids.length < 2) return null
  const index = ids.indexOf(id)
  const start = index === -1 ? 0 : index
  return ids[(start + offset + ids.length) % ids.length] ?? null
}

type Rect = { x: number; y: number; w: number; h: number }

/** Each pane's rectangle in the unit square. */
export function paneRects(node: PaneNode, rect: Rect = { x: 0, y: 0, w: 1, h: 1 }): Map<string, Rect> {
  if (node.type === 'pane') return new Map([[node.id, rect]])
  const firstRect =
    node.direction === 'row'
      ? { ...rect, w: rect.w * node.ratio }
      : { ...rect, h: rect.h * node.ratio }
  const secondRect =
    node.direction === 'row'
      ? { ...rect, x: rect.x + firstRect.w, w: rect.w - firstRect.w }
      : { ...rect, y: rect.y + firstRect.h, h: rect.h - firstRect.h }
  return new Map([...paneRects(node.first, firstRect), ...paneRects(node.second, secondRect)])
}

const EPSILON = 1e-6

/**
 * The pane next to `id` in a screen direction (⌥⌘ + arrow): it must sit on
 * that side and overlap on the other axis; the nearest edge wins, then the
 * one best aligned with the current pane's centre.
 */
export function directionalPaneId(node: PaneNode, id: string, direction: PaneDirection): string | null {
  const rects = paneRects(node)
  const from = rects.get(id)
  if (!from) return null
  const horizontal = direction === 'left' || direction === 'right'
  let best: { id: string; distance: number; offset: number } | null = null
  for (const [candidateId, rect] of rects) {
    if (candidateId === id) continue
    let distance: number
    switch (direction) {
      case 'left':
        distance = from.x - (rect.x + rect.w)
        break
      case 'right':
        distance = rect.x - (from.x + from.w)
        break
      case 'up':
        distance = from.y - (rect.y + rect.h)
        break
      case 'down':
        distance = rect.y - (from.y + from.h)
        break
    }
    if (distance < -EPSILON) continue
    const overlaps = horizontal
      ? rect.y < from.y + from.h - EPSILON && rect.y + rect.h > from.y + EPSILON
      : rect.x < from.x + from.w - EPSILON && rect.x + rect.w > from.x + EPSILON
    if (!overlaps) continue
    const offset = horizontal
      ? Math.abs(rect.y + rect.h / 2 - (from.y + from.h / 2))
      : Math.abs(rect.x + rect.w / 2 - (from.x + from.w / 2))
    if (
      !best ||
      distance < best.distance - EPSILON ||
      (Math.abs(distance - best.distance) <= EPSILON && offset < best.offset)
    ) {
      best = { id: candidateId, distance, offset }
    }
  }
  return best?.id ?? null
}

export type PaneRect = Rect

/** Every split with the rectangle it divides, for drawing drag handles. */
export type SplitDivider = { id: string; direction: 'row' | 'column'; ratio: number; rect: Rect }

export function splitDividers(
  node: PaneNode,
  rect: Rect = { x: 0, y: 0, w: 1, h: 1 },
): SplitDivider[] {
  if (node.type === 'pane') return []
  const firstRect =
    node.direction === 'row'
      ? { ...rect, w: rect.w * node.ratio }
      : { ...rect, h: rect.h * node.ratio }
  const secondRect =
    node.direction === 'row'
      ? { ...rect, x: rect.x + firstRect.w, w: rect.w - firstRect.w }
      : { ...rect, y: rect.y + firstRect.h, h: rect.h - firstRect.h }
  return [
    { id: node.id, direction: node.direction, ratio: node.ratio, rect },
    ...splitDividers(node.first, firstRect),
    ...splitDividers(node.second, secondRect),
  ]
}
