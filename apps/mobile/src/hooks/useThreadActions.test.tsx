import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Haptics from 'expo-haptics'

import { useRelayStore } from '@/store/relay-store'
import { useSessionStore } from '@/store/session-store'
import { snapshot, snapshotEvent, thread, workspace } from '@/test/factories'
import { cleanup, renderComponent } from '@/test/render'

import { useThreadActions } from './useThreadActions'

afterEach(cleanup)

function mountThreadActions() {
  let actions: ReturnType<typeof useThreadActions> | null = null

  function Harness() {
    actions = useThreadActions()
    return null
  }

  renderComponent(<Harness />)

  return actions!
}

describe('useThreadActions archive', () => {
  const originalCallRpc = useRelayStore.getState()._callRpc
  const originalSetError = useRelayStore.getState()._setError

  beforeEach(() => {
    useSessionStore.getState().reset()
    useRelayStore.setState({
      relayUrl: 'https://relay.test',
      pairingCode: '',
      sessionId: null,
      deviceId: null,
      connectionStatus: 'not_connected',
      machinePresence: null,
      error: null,
      isConnected: false,
      isEncrypted: false,
    })
    useRelayStore.getState()._callRpc = originalCallRpc
    useRelayStore.getState()._setError = originalSetError
  })

  afterEach(() => {
    useRelayStore.getState()._callRpc = originalCallRpc
    useRelayStore.getState()._setError = originalSetError
  })

  function loadThreads() {
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          workspaces: [workspace({ id: 'workspace-1', current_thread_id: 't1' })],
          threads: [
            thread({ id: 't1', workspace_id: 'workspace-1' }),
            thread({ id: 't2', workspace_id: 'workspace-1' }),
          ],
        }),
      ),
    )
    useSessionStore.getState().selectThread('workspace-1', 't1')
  }

  it('removes the thread before the archive RPC resolves', async () => {
    loadThreads()
    let resolveRpc!: (value: unknown) => void
    const pending = new Promise((resolve) => {
      resolveRpc = resolve
    })
    useRelayStore.getState()._callRpc = vi.fn().mockReturnValue(pending) as typeof originalCallRpc
    const actions = mountThreadActions()

    let settled = false
    const done = actions.archiveThread('workspace-1', 't1').then(() => {
      settled = true
    })

    expect(useSessionStore.getState().snapshot?.threads.map((entry) => entry.id)).toEqual([
      't1',
      't2',
    ])
    expect(
      useSessionStore.getState().snapshot?.threads.find((entry) => entry.id === 't1')?.is_archived,
    ).toBe(true)
    expect(settled).toBe(false)

    await act(async () => {
      resolveRpc({})
      await done
    })

    expect(settled).toBe(true)
    expect(useRelayStore.getState().error).toBeNull()
  })

  it('does not send a second archive RPC for a thread already dropped locally', async () => {
    loadThreads()
    const rpc = vi.fn().mockResolvedValue({})
    useRelayStore.getState()._callRpc = rpc as typeof originalCallRpc
    const actions = mountThreadActions()

    await actions.archiveThread('workspace-1', 't1')
    await actions.archiveThread('workspace-1', 't1')

    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('puts the thread back and reports the error when archive RPC fails', async () => {
    loadThreads()
    const notificationAsync = vi.spyOn(Haptics, 'notificationAsync')
    useRelayStore.getState()._callRpc = vi
      .fn()
      .mockRejectedValue(new Error('relay down')) as typeof originalCallRpc
    const actions = mountThreadActions()

    await expect(actions.archiveThread('workspace-1', 't1')).rejects.toThrow('relay down')

    expect(useSessionStore.getState().snapshot?.threads.map((entry) => entry.id)).toEqual([
      't1',
      't2',
    ])
    expect(useSessionStore.getState().selectedThreadId).toBe('t1')
    expect(useRelayStore.getState().error).toBe('relay down')
    expect(notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Error)
  })
})

describe('useThreadActions suggest title', () => {
  const originalCallRpc = useRelayStore.getState()._callRpc
  const originalSetError = useRelayStore.getState()._setError

  beforeEach(() => {
    useRelayStore.getState()._callRpc = originalCallRpc
    useRelayStore.getState()._setError = originalSetError
  })

  afterEach(() => {
    useRelayStore.getState()._callRpc = originalCallRpc
    useRelayStore.getState()._setError = originalSetError
  })

  it('returns the generated title from thread.suggestTitle', async () => {
    useRelayStore.getState()._callRpc = vi.fn().mockResolvedValue({
      title: 'Billing webhook',
    }) as typeof originalCallRpc
    const actions = mountThreadActions()

    await expect(
      actions.suggestThreadTitle('workspace-1', 't1'),
    ).resolves.toBe('Billing webhook')
    expect(useRelayStore.getState()._callRpc).toHaveBeenCalledWith(
      'thread.suggestTitle',
      { workspace_id: 'workspace-1', thread_id: 't1' },
      { requestIdPrefix: 'mobile-thread' },
    )
  })
})
