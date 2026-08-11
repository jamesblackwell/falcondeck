import { bench, describe } from 'vitest'

import {
  applyConversationEventToItems,
  applyConversationEventsToItems,
  deriveConversationPresentation,
  reuseConversationPresentation,
} from './conversation'
import { normalizePreferences } from './normalization'
import type { ConversationItem, EventEnvelope } from './types'

const preferences = normalizePreferences(null)
const items: ConversationItem[] = Array.from({ length: 1_000 }, (_, index) =>
  index % 2 === 0
    ? {
        kind: 'user_message',
        id: `user-${index}`,
        text: `Prompt ${index}`,
        attachments: [],
        created_at: '2026-08-09T12:00:00Z',
      }
    : {
        kind: 'assistant_message',
        id: `assistant-${index}`,
        text: `Response ${index}`,
        lifecycle: index === 999 ? 'streaming' : 'complete',
        created_at: '2026-08-09T12:00:00Z',
      },
)
const tail = items.at(-1) as Extract<ConversationItem, { kind: 'assistant_message' }>
let previous = deriveConversationPresentation(items, preferences)
let token = 0
const initialTailLength = tail.text.length
const deltaBurst: EventEnvelope[] = Array.from({ length: 100 }, (_, index) => ({
  seq: index + 1,
  emitted_at: '2026-08-09T12:00:00Z',
  workspace_id: 'workspace-benchmark',
  thread_id: 'thread-benchmark',
  event: {
    type: 'text',
    item_id: tail.id,
    delta: 'x',
    target: 'assistant_text',
    start_offset: initialTailLength + index,
    end_offset: initialTailLength + index + 1,
  },
}))

describe('1,000-message streaming presentation', () => {
  bench('derive and structurally reuse a tail update', () => {
    token += 1
    const nextItems = [
      ...items.slice(0, -1),
      { ...tail, text: `${tail.text} ${token}` },
    ]
    previous = reuseConversationPresentation(
      previous,
      deriveConversationPresentation(nextItems, preferences),
    )
  })
})

describe('1,000-message frame batching', () => {
  bench('apply 100 deltas one event at a time', () => {
    let next = items
    for (const event of deltaBurst) {
      next = applyConversationEventToItems(next, event)
    }
  })

  bench('apply the same 100-delta display frame as one batch', () => {
    applyConversationEventsToItems(items, deltaBurst)
  })
})
