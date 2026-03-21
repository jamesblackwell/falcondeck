import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useRelayStore } from '@/store/relay-store'
import { useSessionStore } from '@/store/session-store'
import { cleanup, renderComponent } from '@/test/render'

import { useInterruptTurn } from './useInterruptTurn'

afterEach(cleanup)

describe('useInterruptTurn', () => {
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

  it('does nothing when no thread is selected', async () => {
    let interrupt: ReturnType<typeof useInterruptTurn> | null = null
    const rpc = vi.fn()

    useRelayStore.getState()._callRpc = rpc as any

    function Harness() {
      interrupt = useInterruptTurn()
      return null
    }

    renderComponent(<Harness />)

    await act(async () => {
      await interrupt!()
    })

    expect(rpc).not.toHaveBeenCalled()
  })

  it('interrupts the active turn and clears errors on success', async () => {
    let interrupt: ReturnType<typeof useInterruptTurn> | null = null
    const rpc = vi.fn().mockResolvedValue(undefined)
    const setError = vi.fn()

    useSessionStore.setState({
      selectedWorkspaceId: 'w1',
      selectedThreadId: 't1',
    } as any)
    useRelayStore.getState()._callRpc = rpc as any
    useRelayStore.getState()._setError = setError as any

    function Harness() {
      interrupt = useInterruptTurn()
      return null
    }

    renderComponent(<Harness />)

    await act(async () => {
      await interrupt!()
    })

    expect(rpc).toHaveBeenCalledWith(
      'turn.interrupt',
      { workspace_id: 'w1', thread_id: 't1' },
      { requestIdPrefix: 'mobile-interrupt' },
    )
    expect(setError).toHaveBeenCalledWith(null)
  })

  it('sets a friendly error message on failure', async () => {
    let interrupt: ReturnType<typeof useInterruptTurn> | null = null
    const rpc = vi.fn().mockRejectedValue(new Error('kaboom'))
    const setError = vi.fn()

    useSessionStore.setState({
      selectedWorkspaceId: 'w1',
      selectedThreadId: 't1',
    } as any)
    useRelayStore.getState()._callRpc = rpc as any
    useRelayStore.getState()._setError = setError as any

    function Harness() {
      interrupt = useInterruptTurn()
      return null
    }

    renderComponent(<Harness />)

    await act(async () => {
      await interrupt!()
    })

    expect(setError).toHaveBeenCalledWith('kaboom')
  })
})
