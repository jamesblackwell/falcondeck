import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import { cleanup, renderComponent } from '@/test/render'
import { DiffBlock } from './DiffBlock'

afterEach(cleanup)
const item = { kind: 'diff' as const, id: 'diff-1',
  diff: Array.from({ length: 400 }, (_, index) => '+changed ' + index).join('\n'),
  created_at: '2026-09-29T10:00:00Z' }

it('mounts code only on expansion and drops it on collapse or cell recycling', () => {
  const renderer = renderComponent(<DiffBlock defaultOpen={false} item={item} />)
  const lines = () => renderer.root.findAll(node => String(node.type) === 'Text' && node.props.selectable)
  expect(lines()).toHaveLength(0)
  const header = () => renderer.root.findByProps({ accessibilityLabel: 'Diff' })
  act(() => header().props.onPress())
  expect(lines()).toHaveLength(400)
  act(() => header().props.onPress())
  expect(lines()).toHaveLength(0)
  act(() => header().props.onPress())
  act(() => renderer.update(<DiffBlock defaultOpen={false} item={{ ...item, id: 'diff-2' }} />))
  expect(header().props.accessibilityState.expanded).toBe(false)
  expect(lines()).toHaveLength(0)
})
