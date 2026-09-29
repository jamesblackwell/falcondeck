import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'

import type { ConversationItem } from '@falcondeck/client-core'

import { cleanup, renderComponent, textOf } from '@/test/render'
import { FileChangeBlock } from './FileChangeBlock'

afterEach(cleanup)

function fileChange(
  overrides: Partial<Extract<ConversationItem, { kind: 'file_change' }>> = {},
): Extract<ConversationItem, { kind: 'file_change' }> {
  return {
    kind: 'file_change',
    id: 'patch-1',
    changes: [{
      path: 'src/old.ts',
      change_kind: 'update',
      diff: '@@ -1 +1 @@\n-old\n+new',
      move_path: 'src/new.ts',
    }],
    status: 'completed',
    lifecycle: 'succeeded',
    created_at: '2026-08-09T10:00:00Z',
    completed_at: '2026-08-09T10:00:01Z',
    ...overrides,
  }
}

describe('FileChangeBlock', () => {
  it('leaves all file previews unmounted while collapsed and after recycling', () => {
    const item = fileChange({ changes: Array.from({ length: 50 }, (_, index) => ({
      path: `file-${index}.ts`, change_kind: 'update', diff: '+one\n+two\n+three', move_path: null,
    })) })
    const renderer = renderComponent(<FileChangeBlock item={item} defaultOpen={false} />)
    const lines = () => renderer.root.findAll(node => String(node.type) === 'Text' && node.props.selectable)
    expect(lines()).toHaveLength(0)
    const header = () => renderer.root.findByProps({ accessibilityLabel: '50 files changed, Completed' })
    act(() => header().props.onPress())
    expect(lines()).toHaveLength(200)
    act(() => header().props.onPress())
    expect(lines()).toHaveLength(0)
    act(() => header().props.onPress())
    act(() => renderer.update(<FileChangeBlock item={{ ...item, id: 'patch-2' }} defaultOpen={false} />))
    expect(lines()).toHaveLength(0)
  })
  it('reveals structured paths, rename destination, and diff accessibly', () => {
    const renderer = renderComponent(<FileChangeBlock item={fileChange()} defaultOpen={false} />)
    const disclosure = renderer.root.findByProps({ accessibilityLabel: 'Renamed old.ts, Completed' })
    expect(disclosure.props.accessibilityState).toEqual({ expanded: false })
    act(() => disclosure.props.onPress())
    expect(disclosure.props.accessibilityState).toEqual({ expanded: true })
    expect(textOf(renderer)).toContain('src/old.ts → src/new.ts')
    expect(textOf(renderer)).toContain('+new')
    expect(
      renderer.root
        .findAllByType('Text' as any)
        .some((node) => node.props.selectable === true),
    ).toBe(true)
  })

  it('shows a running placeholder before patch metadata arrives', () => {
    const renderer = renderComponent(
      <FileChangeBlock
        item={fileChange({ changes: [], status: 'inProgress', lifecycle: 'running' })}
        defaultOpen={false}
      />,
    )
    expect(textOf(renderer)).toContain('Preparing file changes…')
    expect(renderer.root.findByProps({ accessibilityLabel: 'Preparing file changes…, Running' })).toBeDefined()
  })
})
