import { describe, it, expect } from 'vitest'
import type { EventEnvelope } from '@falcondeck/client-core'
import {
  bufferSnapshotRaceEvent,
  canCheckpointReplayCursor,
  isInvalidSavedSessionError,
  shouldReconnectOnAppForeground,
  shouldDeferSnapshotApplication,
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

  it('does nothing when leaving the foreground — the OS tears the socket down', () => {
    expect(shouldReconnectOnAppForeground('background', WebSocket.CLOSED)).toBe(false)
    expect(shouldReconnectOnAppForeground('background', null)).toBe(false)
    expect(shouldReconnectOnAppForeground('inactive', WebSocket.OPEN)).toBe(false)
    expect(shouldReconnectOnAppForeground('inactive', null)).toBe(false)
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
  it('defers while a relay flush may still be decrypting an event', () => {
    expect(shouldDeferSnapshotApplication(true, false)).toBe(true)
  })

  it('defers when the bounded replay buffer overflowed', () => {
    expect(shouldDeferSnapshotApplication(false, true)).toBe(true)
  })

  it('accepts the snapshot when every raced event is ready to replay atomically', () => {
    expect(shouldDeferSnapshotApplication(false, false)).toBe(false)
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
