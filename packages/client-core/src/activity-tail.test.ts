import { describe, expect, it } from 'vitest'

import {
  ACTIVITY_TAIL_LINES,
  activityTailFromItems,
  appendOptimisticTailLine,
  applyEventToActivityTail,
  EMPTY_ACTIVITY_TAIL,
} from './activity-tail'
import type { ConversationItem, EventEnvelope } from './types'

function envelope(event: EventEnvelope['event'], seq = 1): EventEnvelope {
  return {
    seq,
    emitted_at: '2026-08-18T09:00:00Z',
    workspace_id: 'workspace',
    thread_id: 'thread',
    event,
  }
}

const userItem = (id: string, text: string): ConversationItem => ({
  kind: 'user_message',
  id,
  text,
  attachments: [],
  created_at: '2026-08-18T09:00:00Z',
})

describe('activity tails', () => {
  it('collapses history to the newest lines, oldest first', () => {
    const items: ConversationItem[] = Array.from({ length: 12 }, (_, index) =>
      userItem(`item-${index}`, `message ${index}`),
    )
    const tail = activityTailFromItems(items)

    expect(tail.seeded).toBe(true)
    expect(tail.lines).toHaveLength(ACTIVITY_TAIL_LINES)
    expect(tail.lines[0]?.text).toBe('message 4')
    expect(tail.lines.at(-1)?.text).toBe('message 11')
  })

  it('skips items with no one-line summary', () => {
    const tail = activityTailFromItems([
      userItem('kept', 'hello'),
      {
        kind: 'artifact',
        id: 'dropped',
        artifact: {} as never,
        created_at: '2026-08-18T09:00:00Z',
      },
    ])

    expect(tail.lines.map((line) => line.id)).toEqual(['kept'])
  })

  it('accumulates text deltas into one streaming line', () => {
    let tail = applyEventToActivityTail(
      EMPTY_ACTIVITY_TAIL,
      envelope({ type: 'text', item_id: 'answer', delta: 'Reading ' }),
    )
    tail = applyEventToActivityTail(
      tail,
      envelope({ type: 'text', item_id: 'answer', delta: 'the file' }),
    )

    expect(tail.lines).toEqual([
      { id: 'answer', role: 'agent', text: 'Reading the file', streaming: true },
    ])
  })

  it('keeps the end of a line that outgrows the cap', () => {
    let tail = EMPTY_ACTIVITY_TAIL
    for (let index = 0; index < 40; index += 1) {
      tail = applyEventToActivityTail(
        tail,
        envelope({ type: 'text', item_id: 'answer', delta: `chunk-${index} ` }),
      )
    }

    const text = tail.lines[0]?.text ?? ''
    expect(text.startsWith('…')).toBe(true)
    expect(text.trimEnd().endsWith('chunk-39')).toBe(true)
  })

  it('routes reasoning and tool output to their own roles', () => {
    let tail = applyEventToActivityTail(
      EMPTY_ACTIVITY_TAIL,
      envelope({
        type: 'text',
        item_id: 'think',
        delta: 'weighing options',
        target: 'reasoning_summary',
      }),
    )
    tail = applyEventToActivityTail(
      tail,
      envelope({
        type: 'text',
        item_id: 'run',
        delta: '118 passed',
        target: 'tool_output',
      }),
    )

    expect(tail.lines.map((line) => line.role)).toEqual(['thinking', 'tool'])
  })

  it('settles streaming lines and records a failed turn', () => {
    let tail = applyEventToActivityTail(
      EMPTY_ACTIVITY_TAIL,
      envelope({ type: 'text', item_id: 'answer', delta: 'half a thou' }),
    )
    tail = applyEventToActivityTail(
      tail,
      envelope({
        type: 'turn-end',
        turn_id: 'turn-1',
        status: 'failed',
        error: 'Process exited 1',
      }),
    )

    expect(tail.lines[0]?.streaming).toBe(false)
    expect(tail.lines.at(-1)).toMatchObject({
      role: 'error',
      text: 'Process exited 1',
    })
  })

  it('marks a failed tool call as an error without a second line', () => {
    let tail = applyEventToActivityTail(
      EMPTY_ACTIVITY_TAIL,
      envelope({
        type: 'tool-call-start',
        item_id: 'call',
        title: 'npm test',
        kind: 'command_execution',
      }),
    )
    expect(tail.lines[0]).toMatchObject({ role: 'tool', streaming: true })

    tail = applyEventToActivityTail(
      tail,
      envelope({
        type: 'tool-call-end',
        item_id: 'call',
        title: 'npm test',
        kind: 'command_execution',
        status: 'failed',
        exit_code: 1,
      }),
    )
    expect(tail.lines).toHaveLength(1)
    expect(tail.lines[0]).toMatchObject({ role: 'error', streaming: false })
  })

  it('ignores routine protocol chatter', () => {
    const tail = applyEventToActivityTail(
      EMPTY_ACTIVITY_TAIL,
      envelope({ type: 'service', level: 'info', message: 'connected' }),
    )
    expect(tail).toBe(EMPTY_ACTIVITY_TAIL)
  })

  it('returns the same tail when an event changes nothing', () => {
    const tail = applyEventToActivityTail(
      EMPTY_ACTIVITY_TAIL,
      envelope({ type: 'tool-call-start', item_id: 'call', title: 'ls', kind: 'x' }),
    )
    const again = applyEventToActivityTail(
      tail,
      envelope({ type: 'tool-call-start', item_id: 'call', title: 'ls', kind: 'x' }),
    )
    expect(again).toBe(tail)
  })

  it('replaces an optimistic line when the daemon echoes it', () => {
    const optimistic = appendOptimisticTailLine(
      EMPTY_ACTIVITY_TAIL,
      'user-1',
      'run the tests',
    )
    expect(optimistic.lines).toHaveLength(1)

    const echoed = applyEventToActivityTail(
      optimistic,
      envelope({
        type: 'conversation-item-added',
        item: userItem('user-1', 'run the tests'),
      }),
    )
    expect(echoed.lines).toHaveLength(1)
    expect(echoed.lines[0]?.text).toBe('run the tests')
  })
})
