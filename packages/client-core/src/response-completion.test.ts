import { describe, expect, it } from 'vitest'

import {
  advanceResponseCompletionTracker,
  type ResponseCompletionTrackerState,
} from './conversation'
import type { ConversationItem } from './types'

const assistant = (
  id: string,
  lifecycle: 'pending' | 'streaming' | 'complete' | 'interrupted' | 'error',
): ConversationItem => ({
  kind: 'assistant_message',
  id,
  text: lifecycle === 'pending' ? '' : `${id} ${lifecycle}`,
  lifecycle,
  created_at: '2026-08-09T12:00:00Z',
})

function advance(
  state: ResponseCompletionTrackerState | null,
  busy: boolean,
  ready: boolean,
  items: ConversationItem[],
) {
  return advanceResponseCompletionTracker(state, {
    threadKey: 'thread-1',
    busy,
    ready,
    items,
  })
}

describe('response completion tracking', () => {
  it('waits for both the exact assistant and the enclosing turn to settle', () => {
    let result = advance(null, true, false, [assistant('answer-1', 'streaming')])
    expect(result.completed).toBe(false)

    result = advance(result.state, true, false, [assistant('answer-1', 'complete')])
    expect(result.completed).toBe(false)

    result = advance(result.state, false, true, [assistant('answer-1', 'complete')])
    expect(result.completed).toBe(true)

    result = advance(result.state, false, true, [assistant('answer-1', 'complete')])
    expect(result.completed).toBe(false)
  })

  it('survives thread status settling before the item lifecycle', () => {
    let result = advance(null, true, false, [assistant('answer-1', 'streaming')])
    result = advance(result.state, false, true, [assistant('answer-1', 'streaming')])
    expect(result.completed).toBe(false)

    result = advance(result.state, false, true, [assistant('answer-1', 'complete')])
    expect(result.completed).toBe(true)
  })

  it('does not reuse an older answer after a failed send', () => {
    let result = advance(null, false, true, [assistant('old-answer', 'complete')])
    result = advance(result.state, true, false, [assistant('old-answer', 'complete')])
    result = advance(result.state, false, true, [assistant('old-answer', 'complete')])

    expect(result.completed).toBe(false)
  })

  it.each(['interrupted', 'error'] as const)(
    'settles %s without reporting successful completion',
    (lifecycle) => {
      let result = advance(null, true, false, [assistant('answer-1', 'streaming')])
      result = advance(result.state, false, true, [assistant('answer-1', lifecycle)])
      expect(result.completed).toBe(false)

      result = advance(result.state, false, true, [assistant('answer-1', 'complete')])
      expect(result.completed).toBe(false)
    },
  )

  it('seeds a thread switch without announcing loaded history', () => {
    const first = advance(null, false, true, [assistant('answer-1', 'complete')])
    const switched = advanceResponseCompletionTracker(first.state, {
      threadKey: 'thread-2',
      busy: false,
      ready: true,
      items: [assistant('answer-2', 'complete')],
    })

    expect(switched.completed).toBe(false)
  })
})
