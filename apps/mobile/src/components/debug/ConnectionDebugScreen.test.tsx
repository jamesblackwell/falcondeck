import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openConnectionDebug, useConnectionLogStore } from '@/store/connection-log-store'
import { useRelayStore } from '@/store/relay-store'
import { cleanup, renderComponent, textOf } from '@/test/render'
import { ConnectionDebugScreen } from './ConnectionDebugScreen'

describe('ConnectionDebugScreen', () => {
  beforeEach(() => {
    useConnectionLogStore.setState({ entries: [], visible: false })
    useRelayStore.setState({
      connectionStatus: 'encrypted',
      isEncrypted: true,
      isSyncing: true,
      hasSyncedOnce: false,
      machinePresence: {
        session_id: 'session-1',
        daemon_connected: true,
        daemon_rpc_ready: true,
        last_seen_at: null,
      },
      syncDiagnostics: {
        startedAt: null,
        attempt: 0,
        lastAttemptAt: null,
        lastError: null,
        lastErrorAt: null,
        nextRetryAt: null,
        lastSuccessAt: null,
      },
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    useConnectionLogStore.setState({ entries: [], visible: false })
  })

  it('stays closed during a prolonged connection wait', () => {
    vi.useFakeTimers()
    const renderer = renderComponent(<ConnectionDebugScreen />)

    act(() => {
      vi.advanceTimersByTime(30_000)
    })

    expect(renderer.toJSON()).toBeNull()
    expect(useConnectionLogStore.getState().visible).toBe(false)
  })

  it('opens from the connection control with a simple status first', () => {
    const renderer = renderComponent(<ConnectionDebugScreen />)

    act(() => {
      openConnectionDebug()
    })

    const summary = textOf(renderer)
    expect(summary).toContain('Syncing your projects…')
    expect(summary).toContain('View connection details')
    expect(summary).not.toContain('recently synced threads')
    expect(summary).not.toContain('few seconds out of date')
    expect(summary).not.toContain('keep trying automatically')

    const detailsButton = renderer.root.findByProps({
      accessibilityLabel: 'View connection details',
    })
    act(() => {
      detailsButton.props.onPress()
    })

    expect(textOf(renderer)).toContain('Encrypted channel')
  })
})
