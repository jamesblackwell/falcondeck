import { describe, expect, it } from 'vitest'

import {
  captureRelayDisplayFrame,
  encryptedPayloadIsSoleSnapshotEvent,
  parseDaemonEvents,
  relayReplayStillPending,
  returnUnprocessedRelayUpdates,
  selectPresenceFromRelayBatch,
  shouldIgnoreReplaySnapshotEvent,
  shouldPersistRelayFlushCursor,
  shouldYieldBeforeRelayDisplayFlush,
  shouldYieldRelayDisplayFrame,
} from './remote-events'

const event = {
  seq: 7,
  emitted_at: '2026-08-09T08:00:00Z',
  workspace_id: 'workspace-1',
  thread_id: 'thread-1',
  event: {
    type: 'text' as const,
    item_id: 'assistant-1',
    delta: 'hello',
    target: 'assistant_text' as const,
    start_offset: 0,
    end_offset: 5,
  },
}

describe('parseDaemonEvents', () => {
  it('keeps compatibility with the original single-event envelope', () => {
    expect(parseDaemonEvents({ kind: 'daemon-event', event })).toHaveLength(1)
    expect(parseDaemonEvents({ kind: 'daemon-event', event })[0]).toMatchObject(event)
  })

  it('returns ordered events from the batched streaming envelope', () => {
    const second = { ...event, seq: 8, event: { ...event.event, delta: ' world' } }
    expect(parseDaemonEvents({ kind: 'daemon-events', events: [event, second] })).toEqual([
      event,
      second,
    ])
  })

  it('rejects malformed or unrelated envelopes', () => {
    expect(parseDaemonEvents({ kind: 'daemon-events', events: [null, 'bad', {}] })).toHaveLength(0)
    expect(parseDaemonEvents({ kind: 'other', events: [event] })).toEqual([])
    expect(parseDaemonEvents(null)).toEqual([])
  })

  it('rejects interactive events without authoritative routing identity', () => {
    const malformed = {
      ...event,
      event: {
        type: 'interactive-request',
        request: { request_id: '', workspace_id: 'workspace-1', kind: 'approval', questions: [] },
      },
    }

    expect(parseDaemonEvents({ kind: 'daemon-event', event: malformed })).toEqual([])
  })
})

describe('captureRelayDisplayFrame', () => {
  it('leaves updates that arrive during async work queued for a later frame', () => {
    const pending = ['first']

    const captured = captureRelayDisplayFrame(pending)
    pending.push('arrived-during-decryption')

    expect(captured).toEqual(['first'])
    expect(pending).toEqual(['arrived-during-decryption'])
  })
})

describe('shouldYieldRelayDisplayFrame', () => {
  it('yields once the budget is spent and work remains', () => {
    expect(shouldYieldRelayDisplayFrame(0, 8, 3)).toBe(true)
    expect(shouldYieldRelayDisplayFrame(0, 7, 3)).toBe(false)
  })

  it('does not yield when this was the last update, even over budget', () => {
    expect(shouldYieldRelayDisplayFrame(0, 50, 0)).toBe(false)
  })
})

describe('returnUnprocessedRelayUpdates', () => {
  it('puts leftover work ahead of updates that arrived during the frame', () => {
    const pending = ['arrived-during-decryption']
    returnUnprocessedRelayUpdates(pending, ['second', 'third'])
    expect(pending).toEqual(['second', 'third', 'arrived-during-decryption'])
  })

  it('is a no-op when the frame finished the batch', () => {
    const pending = ['arrived-during-decryption']
    returnUnprocessedRelayUpdates(pending, [])
    expect(pending).toEqual(['arrived-during-decryption'])
  })
})

describe('shouldPersistRelayFlushCursor', () => {
  it('skips per-frame persist while leftover replay is still queued', () => {
    expect(shouldPersistRelayFlushCursor(0)).toBe(true)
    expect(shouldPersistRelayFlushCursor(2)).toBe(false)
  })
})

describe('shouldYieldBeforeRelayDisplayFlush', () => {
  it('lets a single live update apply without an extra frame', () => {
    expect(shouldYieldBeforeRelayDisplayFlush(1)).toBe(false)
    expect(shouldYieldBeforeRelayDisplayFlush(0)).toBe(false)
  })

  it('yields before a reconnect dump so cached nav can take a tap', () => {
    expect(shouldYieldBeforeRelayDisplayFlush(2)).toBe(true)
  })
})

describe('relayReplayStillPending', () => {
  it('is never pending without a sync window', () => {
    expect(relayReplayStillPending(null, [{ seq: 1 }], [{ seq: 2 }])).toBe(false)
  })

  it('holds the replay buffer while queued or parked updates sit below next_seq', () => {
    expect(relayReplayStillPending(10, [{ seq: 4 }], [])).toBe(true)
    expect(relayReplayStillPending(10, [], [{ seq: 9 }])).toBe(true)
  })

  it('releases the buffer once only live updates remain', () => {
    expect(relayReplayStillPending(10, [{ seq: 10 }, { seq: 11 }], [])).toBe(false)
    expect(relayReplayStillPending(10, [], [])).toBe(false)
  })
})

describe('selectPresenceFromRelayBatch', () => {
  const presence = {
    session_id: 'session-1',
    daemon_connected: true,
    daemon_rpc_ready: true,
    last_seen_at: '2026-08-22T12:00:00Z',
  }

  it('reads the latest plaintext presence at or above the floor', () => {
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
  })

  it('ignores presence below the sync floor', () => {
    expect(
      selectPresenceFromRelayBatch(
        [{ seq: 4, body: { t: 'presence', presence } }],
        5,
      ),
    ).toBeUndefined()
  })
})

describe('shouldIgnoreReplaySnapshotEvent', () => {
  it('drops durable snapshot envelopes while snapshot.current is in flight', () => {
    expect(shouldIgnoreReplaySnapshotEvent(true, 'snapshot')).toBe(true)
    expect(shouldIgnoreReplaySnapshotEvent(true, 'thread-updated')).toBe(false)
    expect(shouldIgnoreReplaySnapshotEvent(false, 'snapshot')).toBe(false)
  })
})

describe('encryptedPayloadIsSoleSnapshotEvent', () => {
  it('detects a dedicated snapshot envelope from a short prefix', () => {
    expect(
      encryptedPayloadIsSoleSnapshotEvent(
        '{"kind":"daemon-event","event":{"seq":1,"event":{"type":"snapshot","snapshot":{',
      ),
    ).toBe(true)
  })

  it('refuses mixed daemon-events batches so sibling events are still parsed', () => {
    expect(
      encryptedPayloadIsSoleSnapshotEvent(
        '{"kind":"daemon-events","events":[{"event":{"type":"snapshot"}}]}',
      ),
    ).toBe(false)
  })

  it('does not mistake snapshot-shaped provider payloads for a snapshot event', () => {
    expect(
      encryptedPayloadIsSoleSnapshotEvent(
        JSON.stringify({
          kind: 'daemon-event',
          event: {
            seq: 1,
            event: {
              type: 'conversation-item-added',
              item: {
                kind: 'unsupported',
                payload: { type: 'snapshot' },
              },
            },
          },
        }),
      ),
    ).toBe(false)
  })

  it('ignores unrelated payloads', () => {
    expect(
      encryptedPayloadIsSoleSnapshotEvent(
        '{"kind":"daemon-event","event":{"event":{"type":"thread-updated"}}}',
      ),
    ).toBe(false)
    expect(encryptedPayloadIsSoleSnapshotEvent('')).toBe(false)
  })
})
