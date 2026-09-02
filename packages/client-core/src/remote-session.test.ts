import { describe, expect, it } from 'vitest'

import {
  REMOTE_SESSION_STORAGE_VERSION,
  MAX_PENDING_RELAY_UPDATES,
  relayBacklogWouldOverflow,
  relayReconnectDelayMs,
  resolveRelayTruncationCursor,
  shouldReusePersistedRemoteSession,
  type PersistedRemoteSession,
} from './remote-session'

describe('relayReconnectDelayMs', () => {
  it('makes the first retry fast while retaining jitter', () => {
    expect(relayReconnectDelayMs(0, 0)).toBe(200)
    expect(relayReconnectDelayMs(0, 1)).toBe(300)
    expect(relayReconnectDelayMs(1, 0)).toBe(800)
  })

  it('keeps exponential backoff capped during an outage', () => {
    expect(relayReconnectDelayMs(20, 1)).toBe(10_000)
    expect(relayReconnectDelayMs(-2, 0)).toBe(200)
  })
})

describe('relayBacklogWouldOverflow', () => {
  it('accepts a backlog within the bounded queue', () => {
    expect(relayBacklogWouldOverflow(MAX_PENDING_RELAY_UPDATES - 1, 1)).toBe(false)
  })

  it('rejects a backlog that would exceed the bound', () => {
    expect(relayBacklogWouldOverflow(MAX_PENDING_RELAY_UPDATES, 1)).toBe(true)
  })

  it('rejects invalid negative queue sizes', () => {
    expect(relayBacklogWouldOverflow(-1, 0)).toBe(true)
  })
})

describe('resolveRelayTruncationCursor', () => {
  it('adopts the truncation point when an idle replay contains no updates', () => {
    expect(resolveRelayTruncationCursor(42, 0)).toBe(41)
  })

  it('clamps an empty relay session to cursor zero', () => {
    expect(resolveRelayTruncationCursor(0, 0)).toBe(0)
  })

  it('waits while encrypted updates are parked ahead of the cursor', () => {
    expect(resolveRelayTruncationCursor(42, 3)).toBeNull()
  })

  it('does nothing when replay history is continuous', () => {
    expect(resolveRelayTruncationCursor(null, 0)).toBeNull()
  })
})

describe('shouldReusePersistedRemoteSession', () => {
  const session: PersistedRemoteSession = {
    version: REMOTE_SESSION_STORAGE_VERSION,
    relayUrl: 'https://connect.falcondeck.com',
    pairingCode: '',
    sessionId: 'session-1',
    clientToken: 'token',
    clientSecretKey: 'secret',
  }

  it('does not let a pairing link replace an authenticated tab session', () => {
    const params = new URLSearchParams({
      code: 'ATTACKER-CODE',
      relay: 'https://relay.attacker.example',
    })
    expect(shouldReusePersistedRemoteSession(params, session)).toBe(session)
  })
})
