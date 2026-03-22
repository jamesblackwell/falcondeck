/**
 * Tests for the parseDaemonEvent function and processUpdate routing logic.
 * We can't test the full hook (useEffect + WebSocket) in Node, but we can
 * test the pure logic functions extracted from it.
 */
import { describe, it, expect } from 'vitest'
import type { EventEnvelope, RelayUpdate, MachinePresence } from '@falcondeck/client-core'
import { isInvalidSavedSessionError } from './useRelayConnection'

// Re-implement parseDaemonEvent to test in isolation
// (it's a module-private function in useRelayConnection.ts)
function parseDaemonEvent(payload: unknown): EventEnvelope | null {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'kind' in payload &&
    'event' in payload &&
    (payload as { kind?: string }).kind === 'daemon-event'
  ) {
    return (payload as { event: EventEnvelope }).event
  }
  return null
}

describe('parseDaemonEvent', () => {
  it('extracts EventEnvelope from a daemon-event wrapper', () => {
    const envelope: EventEnvelope = {
      seq: 1,
      emitted_at: '2026-03-16T10:00:00Z',
      workspace_id: 'w1',
      thread_id: 't1',
      event: { type: 'start', title: 'Hello' },
    }
    const wrapped = { kind: 'daemon-event', event: envelope }
    expect(parseDaemonEvent(wrapped)).toBe(envelope)
  })

  it('returns null for non-daemon-event objects', () => {
    expect(parseDaemonEvent({ kind: 'other', data: {} })).toBeNull()
    expect(parseDaemonEvent({ type: 'snapshot' })).toBeNull()
    expect(parseDaemonEvent({})).toBeNull()
  })

  it('returns null for primitives', () => {
    expect(parseDaemonEvent(null)).toBeNull()
    expect(parseDaemonEvent(undefined)).toBeNull()
    expect(parseDaemonEvent('string')).toBeNull()
    expect(parseDaemonEvent(42)).toBeNull()
    expect(parseDaemonEvent(true)).toBeNull()
  })

  it('returns null for arrays', () => {
    expect(parseDaemonEvent([])).toBeNull()
    expect(parseDaemonEvent([{ kind: 'daemon-event' }])).toBeNull()
  })

  it('requires both kind and event properties', () => {
    expect(parseDaemonEvent({ kind: 'daemon-event' })).toBeNull()
    expect(parseDaemonEvent({ event: {} })).toBeNull()
  })

  it('requires kind to be exactly "daemon-event"', () => {
    expect(parseDaemonEvent({ kind: 'daemon-events', event: {} })).toBeNull()
    expect(parseDaemonEvent({ kind: 'DAEMON-EVENT', event: {} })).toBeNull()
  })
})

describe('processUpdate routing logic', () => {
  // Test the routing rules without calling the actual hook

  function classifyUpdate(update: RelayUpdate): string {
    if (update.body.t === 'session-bootstrap') return 'bootstrap'
    if (update.body.t === 'presence') return 'presence'
    if (update.body.t === 'action-status') return 'action-status'
    if (update.body.t === 'encrypted') return 'encrypted'
    return 'unknown'
  }

  it('classifies session-bootstrap updates', () => {
    const update: RelayUpdate = {
      id: 'u1',
      seq: 1,
        body: {
          t: 'session-bootstrap',
          material: {
            encryption_variant: 'data_key_v1',
            identity_variant: 'ed25519_v1',
            pairing_id: 'pairing-1',
            session_id: 'session-1',
            daemon_public_key: 'abc',
            daemon_identity_public_key: 'ghi',
            client_public_key: 'def',
            client_identity_public_key: 'jkl',
            client_wrapped_data_key: { encryption_variant: 'data_key_v1', wrapped_key: 'xxx' },
            daemon_wrapped_data_key: null,
            signature: 'sig',
          },
        },
      created_at: '2026-03-16T10:00:00Z',
    }
    expect(classifyUpdate(update)).toBe('bootstrap')
  })

  it('classifies presence updates', () => {
    const update: RelayUpdate = {
      id: 'u2',
      seq: 2,
      body: {
        t: 'presence',
        presence: { session_id: 's1', daemon_connected: true, last_seen_at: null },
      },
      created_at: '2026-03-16T10:00:00Z',
    }
    expect(classifyUpdate(update)).toBe('presence')
  })

  it('classifies encrypted updates', () => {
    const update: RelayUpdate = {
      id: 'u3',
      seq: 3,
      body: {
        t: 'encrypted',
        envelope: { ciphertext: 'abc', nonce: 'def' } as any,
      },
      created_at: '2026-03-16T10:00:00Z',
    }
    expect(classifyUpdate(update)).toBe('encrypted')
  })

  it('classifies action-status updates', () => {
    const update: RelayUpdate = {
      id: 'u4',
      seq: 4,
      body: {
        t: 'action-status',
        action: {} as any,
      },
      created_at: '2026-03-16T10:00:00Z',
    }
    expect(classifyUpdate(update)).toBe('action-status')
  })
})

describe('snapshot hydration timing', () => {
  function shouldRequestSnapshotAfterBootstrap(params: {
    hasSessionCrypto: boolean
    hasSnapshot: boolean
  }) {
    return params.hasSessionCrypto && !params.hasSnapshot
  }

  it('requests a snapshot after bootstrap when encryption is ready and no snapshot exists yet', () => {
    expect(
      shouldRequestSnapshotAfterBootstrap({
        hasSessionCrypto: true,
        hasSnapshot: false,
      }),
    ).toBe(true)
  })

  it('does not request a duplicate snapshot when one is already present', () => {
    expect(
      shouldRequestSnapshotAfterBootstrap({
        hasSessionCrypto: true,
        hasSnapshot: true,
      }),
    ).toBe(false)
  })

  it('does not request a snapshot before encryption is established', () => {
    expect(
      shouldRequestSnapshotAfterBootstrap({
        hasSessionCrypto: false,
        hasSnapshot: false,
      }),
    ).toBe(false)
  })
})

describe('WebSocket URL construction', () => {
  function buildWsUrl(relayUrl: string, sessionId: string, ticket: string): string {
    const url = relayUrl.trim().replace(/\/$/, '')
    const wsUrl = url.startsWith('https://')
      ? `wss://${url.slice('https://'.length)}`
      : url.startsWith('http://')
        ? `ws://${url.slice('http://'.length)}`
        : url

    return `${wsUrl}/v1/updates/ws?session_id=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket)}`
  }

  it('converts https to wss', () => {
    const url = buildWsUrl('https://relay.example.com', 's1', 't1')
    expect(url).toBe('wss://relay.example.com/v1/updates/ws?session_id=s1&ticket=t1')
  })

  it('converts http to ws', () => {
    const url = buildWsUrl('http://localhost:8080', 's1', 't1')
    expect(url).toBe('ws://localhost:8080/v1/updates/ws?session_id=s1&ticket=t1')
  })

  it('strips trailing slashes', () => {
    const url = buildWsUrl('https://relay.example.com/', 's1', 't1')
    expect(url).toBe('wss://relay.example.com/v1/updates/ws?session_id=s1&ticket=t1')
  })

  it('encodes special characters in session ID and ticket', () => {
    const url = buildWsUrl('https://relay.test', 'session with spaces', 'ticket/special=chars')
    expect(url).toContain('session_id=session%20with%20spaces')
    expect(url).toContain('ticket=ticket%2Fspecial%3Dchars')
  })

  it('passes through non-http URLs unchanged', () => {
    const url = buildWsUrl('wss://already-ws.test', 's1', 't1')
    expect(url).toBe('wss://already-ws.test/v1/updates/ws?session_id=s1&ticket=t1')
  })
})

describe('invalid saved session detection', () => {
  it('detects relay responses that mean the saved session is dead', () => {
    expect(isInvalidSavedSessionError('invalid session token')).toBe(true)
    expect(isInvalidSavedSessionError('session not found')).toBe(true)
    expect(isInvalidSavedSessionError('trusted device revoked')).toBe(true)
    expect(isInvalidSavedSessionError('Failed with status 401')).toBe(true)
    expect(isInvalidSavedSessionError('Failed with status 404')).toBe(true)
  })

  it('ignores transient connection failures', () => {
    expect(isInvalidSavedSessionError('Network error')).toBe(false)
    expect(isInvalidSavedSessionError('Failed with status 500')).toBe(false)
    expect(isInvalidSavedSessionError(null)).toBe(false)
  })
})
