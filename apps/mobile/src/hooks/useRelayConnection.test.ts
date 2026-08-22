import { describe, it, expect } from 'vitest'
import type { EventEnvelope } from '@falcondeck/client-core'
import {
  bufferSnapshotRaceEvent,
  canCheckpointReplayCursor,
  isInvalidSavedSessionError,
  selectPresenceFromRelayBatch,
  shouldPingRelayOnLeavingForeground,
  shouldReconnectOnAppForeground,
  shouldIgnoreReplaySnapshotEvent,
  shouldParkSnapshotApplication,
  shouldRefetchSnapshotApplication,
} from './useRelayConnection'

describe('foreground reconnect trigger', () => {
  it('reconnects when foregrounding with a dead socket', () => {
    expect(shouldReconnectOnAppForeground('active', WebSocket.CLOSED)).toBe(true)
    expect(shouldReconnectOnAppForeground('active', WebSocket.CLOSING)).toBe(true)
    expect(shouldReconnectOnAppForeground('active', WebSocket.CONNECTING)).toBe(true)
  })

  it('reconnects when foregrounding with no socket at all', () => {
    expect(shouldReconnectOnAppForeground('active', null)).toBe(true)
  })

  it('does nothing when foregrounding with a healthy open socket', () => {
    expect(shouldReconnectOnAppForeground('active', WebSocket.OPEN)).toBe(false)
  })

  it('does not reconnect just because the app left the foreground', () => {
    expect(shouldReconnectOnAppForeground('background', WebSocket.CLOSED)).toBe(false)
    expect(shouldReconnectOnAppForeground('background', null)).toBe(false)
    expect(shouldReconnectOnAppForeground('inactive', WebSocket.OPEN)).toBe(false)
    expect(shouldReconnectOnAppForeground('inactive', null)).toBe(false)
  })
})

describe('background relay ping', () => {
  it('pings when leaving the foreground with a live socket', () => {
    expect(shouldPingRelayOnLeavingForeground('inactive', WebSocket.OPEN)).toBe(true)
    expect(shouldPingRelayOnLeavingForeground('background', WebSocket.OPEN)).toBe(true)
  })

  it('does not ping when the socket is already dead', () => {
    expect(shouldPingRelayOnLeavingForeground('background', WebSocket.CLOSED)).toBe(false)
    expect(shouldPingRelayOnLeavingForeground('background', WebSocket.CONNECTING)).toBe(false)
    expect(shouldPingRelayOnLeavingForeground('background', null)).toBe(false)
  })

  it('does not ping when becoming active — that path reconnects if needed', () => {
    expect(shouldPingRelayOnLeavingForeground('active', WebSocket.OPEN)).toBe(false)
  })
})

describe('invalid saved session detection', () => {
  it('detects the relay-authored errors that mean the saved session is dead', () => {
    expect(isInvalidSavedSessionError('invalid session token')).toBe(true)
    expect(isInvalidSavedSessionError('session not found')).toBe(true)
    expect(isInvalidSavedSessionError('trusted device is revoked or missing')).toBe(true)
    expect(isInvalidSavedSessionError('trusted device is revoked')).toBe(true)
    expect(isInvalidSavedSessionError('trusted device not found')).toBe(true)
    // Case-insensitive and whitespace-tolerant, but still exact.
    expect(isInvalidSavedSessionError('Session not found')).toBe(true)
    expect(isInvalidSavedSessionError(' invalid session token ')).toBe(true)
  })

  it('ignores transient connection failures', () => {
    expect(isInvalidSavedSessionError('Network error')).toBe(false)
    expect(isInvalidSavedSessionError('Failed with status 500')).toBe(false)
    expect(isInvalidSavedSessionError(null)).toBe(false)
  })

  it('ignores generic HTTP status fallbacks — proxies and CDNs answer 401/404 too', () => {
    expect(isInvalidSavedSessionError('Failed with status 401')).toBe(false)
    expect(isInvalidSavedSessionError('Failed with status 404')).toBe(false)
  })

  it('ignores messages that merely mention the relay error strings', () => {
    expect(isInvalidSavedSessionError('proxy error: session not found in cache backend')).toBe(false)
    expect(isInvalidSavedSessionError('trusted device sync postponed')).toBe(false)
    expect(isInvalidSavedSessionError('upstream said "invalid session token" while restarting')).toBe(false)
  })
})

describe('snapshot race recovery', () => {
  it('parks while a relay flush may still be decrypting an event', () => {
    expect(shouldParkSnapshotApplication(true, 0)).toBe(true)
  })

  it('parks when updates are queued for the next frame', () => {
    expect(shouldParkSnapshotApplication(false, 3)).toBe(true)
  })

  it('does not park when nothing is in flight or queued', () => {
    expect(shouldParkSnapshotApplication(false, 0)).toBe(false)
  })

  it('refetches only when the bounded replay buffer overflowed', () => {
    expect(shouldRefetchSnapshotApplication(true)).toBe(true)
    expect(shouldRefetchSnapshotApplication(false)).toBe(false)
  })

  it('drops durable snapshot envelopes while snapshot.current is in flight', () => {
    expect(shouldIgnoreReplaySnapshotEvent(true, 'snapshot')).toBe(true)
    expect(shouldIgnoreReplaySnapshotEvent(true, 'thread-updated')).toBe(false)
    expect(shouldIgnoreReplaySnapshotEvent(false, 'snapshot')).toBe(false)
  })

  it('reads plaintext presence before decrypt so snapshot.current can start first', () => {
    const presence = {
      session_id: 'session-1',
      daemon_connected: true,
      daemon_rpc_ready: true,
      last_seen_at: '2026-08-22T12:00:00Z',
    }
    expect(
      selectPresenceFromRelayBatch(
        [
          { seq: 3, body: { t: 'encrypted' } },
          { seq: 4, body: { t: 'presence', presence } },
          {
            seq: 5,
            body: {
              t: 'presence',
              presence: { ...presence, daemon_connected: false },
            },
          },
        ],
        null,
      ),
    ).toEqual({ ...presence, daemon_connected: false })

    expect(
      selectPresenceFromRelayBatch(
        [
          { seq: 4, body: { t: 'presence', presence } },
          {
            seq: 5,
            body: {
              t: 'presence',
              presence: { ...presence, daemon_connected: false },
            },
          },
        ],
        5,
      ),
    ).toEqual({ ...presence, daemon_connected: false })

    expect(
      selectPresenceFromRelayBatch(
        [{ seq: 4, body: { t: 'presence', presence } }],
        5,
      ),
    ).toBeUndefined()
  })

  it('deduplicates raced events and reports bounded-buffer overflow', () => {
    const first: EventEnvelope = {
      seq: 11,
      emitted_at: '2026-03-16T10:00:00Z',
      workspace_id: 'w1',
      thread_id: 't1',
      event: { type: 'start', title: 'First' },
    }
    const second: EventEnvelope = {
      ...first,
      seq: 12,
      event: { type: 'start', title: 'Second' },
    }
    const buffer: EventEnvelope[] = []
    const seen = new Set<number>()

    expect(bufferSnapshotRaceEvent(buffer, seen, first, 1)).toBe(false)
    expect(bufferSnapshotRaceEvent(buffer, seen, first, 1)).toBe(false)
    expect(bufferSnapshotRaceEvent(buffer, seen, second, 1)).toBe(true)
    expect(buffer).toEqual([first])
    expect(seen).toEqual(new Set([11]))
  })
})

describe('replay cursor checkpointing', () => {
  it('allows a checkpoint once all consumed events are applied', () => {
    expect(
      canCheckpointReplayCursor({
        authoritativeSnapshot: true,
        snapshotRequestInFlight: false,
        pendingSnapshotEventCount: 0,
        snapshotRaceOverflowed: false,
        parkedUpdateCount: 0,
      }),
    ).toBe(true)
  })

  it('holds the cursor while a snapshot race is still in flight', () => {
    expect(
      canCheckpointReplayCursor({
        authoritativeSnapshot: true,
        snapshotRequestInFlight: true,
        pendingSnapshotEventCount: 0,
        snapshotRaceOverflowed: false,
        parkedUpdateCount: 0,
      }),
    ).toBe(false)
  })

  it('rejects checkpoints with buffered, overflowed, or parked replay state', () => {
    expect(
      canCheckpointReplayCursor({
        authoritativeSnapshot: true,
        snapshotRequestInFlight: false,
        pendingSnapshotEventCount: 1,
        snapshotRaceOverflowed: false,
        parkedUpdateCount: 0,
      }),
    ).toBe(false)
    expect(
      canCheckpointReplayCursor({
        authoritativeSnapshot: true,
        snapshotRequestInFlight: false,
        pendingSnapshotEventCount: 0,
        snapshotRaceOverflowed: true,
        parkedUpdateCount: 0,
      }),
    ).toBe(false)
    expect(
      canCheckpointReplayCursor({
        authoritativeSnapshot: true,
        snapshotRequestInFlight: false,
        pendingSnapshotEventCount: 0,
        snapshotRaceOverflowed: false,
        parkedUpdateCount: 1,
      }),
    ).toBe(false)
  })
})
