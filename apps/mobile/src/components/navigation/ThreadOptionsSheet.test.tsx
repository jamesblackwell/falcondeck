import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Haptics from 'expo-haptics'

import { useRelayStore } from '@/store/relay-store'
import { useSessionStore } from '@/store/session-store'
import { cleanup, renderComponent, textOf } from '@/test/render'
import { snapshot, snapshotEvent, thread, workspace } from '@/test/factories'

import { ThreadOptionsSheet } from './ThreadOptionsSheet'

afterEach(cleanup)

describe('ThreadOptionsSheet', () => {
  const originalCallRpc = useRelayStore.getState()._callRpc

  beforeEach(() => {
    useSessionStore.getState().reset()
    useRelayStore.getState()._callRpc = originalCallRpc
  })

  afterEach(() => {
    useRelayStore.getState()._callRpc = originalCallRpc
  })

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
    expect(textOf(renderer)).toContain('Pin in project')
    expect(textOf(renderer)).toContain('Rename')
    expect(textOf(renderer)).toContain('Archive')
  })

  it('hides pin in project for casual chats', () => {
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          workspaces: [workspace({ id: 'workspace-1', kind: 'casual' })],
          threads: [thread({ id: 'thread-1', workspace_id: 'workspace-1' })],
        }),
      ),
    )
    const renderer = renderComponent(
      <ThreadOptionsSheet
        workspaceId="workspace-1"
        thread={thread({ id: 'thread-1', workspace_id: 'workspace-1' })}
        onClose={vi.fn()}
      />,
    )

    expect(textOf(renderer)).toContain('Pin')
    expect(textOf(renderer)).not.toContain('Pin in project')
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
    expect(textOf(renderer)).toContain('Suggest title')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('archives immediately with haptic feedback without waiting for RPC', () => {
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(snapshot({
        workspaces: [workspace({ id: 'workspace-1', current_thread_id: 'thread-1' })],
        threads: [
          thread({ id: 'thread-1', workspace_id: 'workspace-1' }),
          thread({ id: 'thread-2', workspace_id: 'workspace-1' }),
        ],
      })),
    )
    useSessionStore.getState().selectThread('workspace-1', 'thread-1')

    let resolveRpc!: (value: unknown) => void
    const pending = new Promise((resolve) => {
      resolveRpc = resolve
    })
    const rpc = vi.fn().mockReturnValue(pending)
    useRelayStore.getState()._callRpc = rpc as typeof originalCallRpc
    const impactAsync = vi.spyOn(Haptics, 'impactAsync')
    const onClose = vi.fn()
    const renderer = renderComponent(
      <ThreadOptionsSheet
        workspaceId="workspace-1"
        thread={thread({ id: 'thread-1', workspace_id: 'workspace-1' })}
        onClose={onClose}
      />,
    )
    const archive = renderer.root.findByProps({ accessibilityLabel: 'Archive thread' })

    act(() => archive.props.onPress())

    expect(impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium)
    expect(onClose).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().snapshot?.threads.map((entry) => entry.id)).toEqual([
      'thread-1',
      'thread-2',
    ])
    expect(
      useSessionStore
        .getState()
        .snapshot?.threads.find((entry) => entry.id === 'thread-1')?.is_archived,
    ).toBe(true)
    expect(rpc).toHaveBeenCalledWith(
      'thread.archive',
      { workspace_id: 'workspace-1', thread_id: 'thread-1' },
      { requestIdPrefix: 'mobile-thread' },
    )

    act(() => resolveRpc({}))
  })

  it('coalesces repeated pin taps while the first mutation is pending', async () => {
    let resolveRpc!: (value: unknown) => void
    const pending = new Promise((resolve) => {
      resolveRpc = resolve
    })
    const rpc = vi.fn().mockReturnValue(pending)
    useRelayStore.getState()._callRpc = rpc as typeof originalCallRpc
    const renderer = renderComponent(
      <ThreadOptionsSheet
        workspaceId="workspace-1"
        thread={thread({ id: 'thread-1', workspace_id: 'workspace-1' })}
        onClose={vi.fn()}
      />,
    )
    const pin = renderer.root.findByProps({ accessibilityLabel: 'Pin thread' })

    act(() => {
      pin.props.onPress()
      pin.props.onPress()
    })

    expect(rpc).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveRpc({})
      await pending
    })
  })
})
