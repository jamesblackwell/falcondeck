import { bench, describe } from 'vitest'

import { parseDaemonEvents } from './remote-events'
import type { EventEnvelope } from './types'

const events: EventEnvelope[] = Array.from({ length: 128 }, (_, index) => ({
  seq: index + 1,
  emitted_at: '2026-08-09T12:00:00Z',
  workspace_id: 'workspace-benchmark',
  thread_id: 'thread-benchmark',
  event: {
    type: 'text',
    item_id: 'assistant-benchmark',
    delta: 'token',
    target: 'assistant_text',
    start_offset: index * 5,
    end_offset: index * 5 + 5,
  },
}))

const singlePayloads = events.map((event) => ({ kind: 'daemon-event', event }))
const batchPayload = { kind: 'daemon-events', events }

describe('remote daemon event decoding', () => {
  bench('parses 128 single-event envelopes', () => {
    for (const payload of singlePayloads) {
      parseDaemonEvents(payload)
    }
  })

  bench('parses one 128-event batch envelope', () => {
    parseDaemonEvents(batchPayload)
  })
})
