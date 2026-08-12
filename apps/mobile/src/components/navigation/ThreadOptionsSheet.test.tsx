import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cleanup, renderComponent, textOf } from '@/test/render'
import { thread } from '@/test/factories'

import { ThreadOptionsSheet } from './ThreadOptionsSheet'

afterEach(cleanup)

describe('ThreadOptionsSheet', () => {
  it('offers pin, rename, and archive for the selected thread', () => {
    const renderer = renderComponent(
      <ThreadOptionsSheet
        workspaceId="workspace-1"
        thread={thread({ id: 'thread-1', workspace_id: 'workspace-1' })}
        onClose={vi.fn()}
      />,
    )

    expect(textOf(renderer)).toContain('Thread options')
    expect(textOf(renderer)).toContain('Pin')
    expect(textOf(renderer)).toContain('Rename')
    expect(textOf(renderer)).toContain('Archive')
  })

  it('opens the rename form without dismissing the sheet', () => {
    const onClose = vi.fn()
    const renderer = renderComponent(
      <ThreadOptionsSheet
        workspaceId="workspace-1"
        thread={thread({ id: 'thread-1', workspace_id: 'workspace-1' })}
        onClose={onClose}
      />,
    )
    const rename = renderer.root.findByProps({ accessibilityLabel: 'Rename thread' })

    act(() => rename.props.onPress())

    expect(textOf(renderer)).toContain('Rename thread')
    expect(textOf(renderer)).toContain('Save')
    expect(onClose).not.toHaveBeenCalled()
  })
})
