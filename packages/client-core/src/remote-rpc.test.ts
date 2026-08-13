import { describe, expect, it } from 'vitest'

import { RELAY_RPC_TIMEOUT_MS, relayRpcFailureMessage } from './remote-rpc'

describe('relayRpcFailureMessage', () => {
  it('waits long enough to receive the relay-owned 30 second timeout', () => {
    expect(RELAY_RPC_TIMEOUT_MS).toBeGreaterThan(30_000)
  })

  it('names an unavailable method and the automatic recovery', () => {
    expect(relayRpcFailureMessage('method_unavailable', 'snapshot.current')).toBe(
      'Your Mac is connected, but snapshot.current is not registered. FalconDeck will retry automatically.',
    )
  })

  it('does not promise automatic retries for one-shot remote actions', () => {
    expect(relayRpcFailureMessage('method_unavailable', 'thread.detail')).toBe(
      'Your Mac is connected, but thread.detail is not registered. Try again in a moment.',
    )
  })

  it('does not collapse missing relay detail into a generic action error', () => {
    expect(relayRpcFailureMessage(undefined, 'thread.detail')).toBe(
      'Remote thread.detail failed without details.',
    )
  })
})
