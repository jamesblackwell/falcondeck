import { describe, expect, it } from 'vitest'

import { captureRelayDisplayFrame, parseDaemonEvents } from './remote-events'

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
