import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { deriveThreadAttentionPresentation } from '@falcondeck/client-core'

import { useRelayStore } from '@/store/relay-store'
import { useSessionStore } from '@/store/session-store'
import { snapshot, snapshotEvent, thread } from '@/test/factories'
import { cleanup, renderComponent } from '@/test/render'

import { useAutoMarkThreadRead } from './useAutoMarkThreadRead'
import { clearAutoMarkReadSuppression } from './useThreadActions'

afterEach(cleanup)

function unreadThread() {
  return thread({
    attention: {
      ...thread().attention,
      level: 'unread',
      unread: true,
      last_agent_activity_seq: 9,
      last_read_seq: 0,
    },
  })
}

function readThreadFrom(source = unreadThread()) {
  return {
    ...source,
    attention: {
      ...source.attention,
      level: 'none' as const,
      unread: false,
      last_read_seq: source.attention.last_agent_activity_seq,
    },
  }
}

function Harness({
  appState = 'active',
  isEncrypted = true,
  workspaceId = 'workspace-1',
  thread: selectedThread,
}: {
  appState?: string
  isEncrypted?: boolean
  workspaceId?: string | null
  thread: ReturnType<typeof thread> | null
}) {
  useAutoMarkThreadRead({
    appState,
    isEncrypted,
    workspaceId,
    thread: selectedThread,
  })
  return null
}

describe('useAutoMarkThreadRead', () => {
  const originalCallRpc = useRelayStore.getState()._callRpc

  beforeEach(() => {
    vi.useFakeTimers()
    clearAutoMarkReadSuppression()
    useSessionStore.getState().reset()
    useRelayStore.getState()._callRpc = originalCallRpc
  })

  afterEach(() => {
    vi.useRealTimers()
    useRelayStore.getState()._callRpc = originalCallRpc
    clearAutoMarkReadSuppression()
  })

  it('marks the open thread read over RPC and clears the unread flag locally', async () => {
    const selected = unreadThread()
    const rpc = vi.fn().mockResolvedValue(readThreadFrom(selected))
    useRelayStore.getState()._callRpc = rpc as typeof originalCallRpc
    useSessionStore.getState().applyDaemonEvent(snapshotEvent(snapshot({ threads: [selected] })))

    expect(deriveThreadAttentionPresentation(selected).showUnreadDot).toBe(true)

    renderComponent(
      <Harness thread={useSessionStore.getState().snapshot!.threads[0]!} />,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(rpc).toHaveBeenCalledWith(
      'thread.mark_read',
      {
        workspace_id: 'workspace-1',
        thread_id: 'thread-1',
        read_seq: 9,
      },
      { requestIdPrefix: 'mobile-thread' },
    )

    const updated = useSessionStore.getState().snapshot?.threads[0]
    expect(updated?.attention.unread).toBe(false)
    expect(updated?.attention.last_read_seq).toBe(9)
    expect(deriveThreadAttentionPresentation(updated!).showUnreadDot).toBe(false)
  })

  it('does not treat a failed mark-read as sent, so opening again can retry', async () => {
    const selected = unreadThread()
    const rpc = vi.fn().mockRejectedValue(new Error('relay down'))
    useRelayStore.getState()._callRpc = rpc as typeof originalCallRpc
    useSessionStore.getState().applyDaemonEvent(snapshotEvent(snapshot({ threads: [selected] })))

    const renderer = renderComponent(<Harness thread={selected} />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().snapshot?.threads[0]?.attention.unread).toBe(true)

    rpc.mockResolvedValue(readThreadFrom(selected))
    await act(async () => {
      renderer.unmount()
    })
    renderComponent(<Harness thread={selected} />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(rpc).toHaveBeenCalledTimes(2)
    expect(useSessionStore.getState().snapshot?.threads[0]?.attention.unread).toBe(false)
  })

  it('does not fire while the app is backgrounded', async () => {
    const rpc = vi.fn()
    useRelayStore.getState()._callRpc = rpc as typeof originalCallRpc

    renderComponent(<Harness appState="background" thread={unreadThread()} />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(rpc).not.toHaveBeenCalled()
  })
})
