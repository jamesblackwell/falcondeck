import { describe, expect, it } from 'vitest'

import { isDaemonRpcReady, RELAY_RPC_TIMEOUT_MS, relayRpcFailureMessage } from './remote-rpc'

describe('isDaemonRpcReady', () => {
  it('waits for an explicitly unready registry even when the daemon socket is online', () => {
    expect(isDaemonRpcReady({
      session_id: 'session-1',
      daemon_connected: true,
      daemon_rpc_ready: false,
      last_seen_at: null,
    })).toBe(false)
  })

  it('falls back to daemon presence for legacy relays', () => {
    expect(isDaemonRpcReady({
      session_id: 'session-1',
      daemon_connected: true,
      last_seen_at: null,
    })).toBe(true)
  })
})

describe('relayRpcFailureMessage', () => {
  it('waits long enough to receive the relay-owned 30 second timeout', () => {
    expect(RELAY_RPC_TIMEOUT_MS).toBeGreaterThan(30_000)
  })

  it('names an unavailable method and the automatic recovery', () => {
    expect(relayRpcFailureMessage('method_unavailable', 'snapshot.current')).toBe(
      'Desktop is connected, but sync is not ready yet. FalconDeck will retry automatically.',
    )
  })

  it('does not promise automatic retries for one-shot remote actions', () => {
    expect(relayRpcFailureMessage('method_unavailable', 'thread.detail')).toBe(
      'Desktop is connected, but that action is not ready yet. Try again in a moment.',
    )
  })

  it('blames the desktop hop when the responder leaves the relay', () => {
    expect(relayRpcFailureMessage('responder_disconnected', 'snapshot.current')).toBe(
      'Desktop disconnected from the relay.',
    )
  })

  it('keeps a timeout generic because either hop can stall', () => {
    expect(relayRpcFailureMessage('timed_out', 'snapshot.current')).toBe(
      'Timed out waiting for a response.',
    )
  })

  it('does not collapse missing relay detail into a generic action error', () => {
    expect(relayRpcFailureMessage(undefined, 'thread.detail')).toBe(
      'The request failed without details.',
    )
  })
})
