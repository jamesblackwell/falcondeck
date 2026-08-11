import { describe, expect, it } from 'vitest'

import {
  applyConversationEventToItems,
  type ConversationItem,
  type EventEnvelope,
} from '@falcondeck/client-core'

const createdAt = '2026-08-08T20:00:00Z'

function event(event: EventEnvelope['event']): EventEnvelope {
  return {
    seq: 1,
    emitted_at: createdAt,
    workspace_id: 'workspace-1',
    thread_id: 'thread-1',
    event,
  }
}

describe('conversation text streaming', () => {
  it('applies UTF-16 assistant deltas and ignores an exact replay', () => {
    const items: ConversationItem[] = [
      {
        kind: 'assistant_message',
        id: 'assistant-1',
        text: 'Hi ',
        created_at: createdAt,
      },
    ]
    const delta = event({
      type: 'text',
      item_id: 'assistant-1',
      delta: '🙂',
      target: 'assistant_text',
      start_offset: 3,
      end_offset: 5,
    })

    const applied = applyConversationEventToItems(items, delta)
    expect(applied[0]).toMatchObject({ text: 'Hi 🙂', lifecycle: 'streaming' })
    expect(applyConversationEventToItems(applied, delta)).toBe(applied)
  })

  it('rejects gaps, malformed ranges, and legacy unanchored deltas', () => {
    const items: ConversationItem[] = [
      {
        kind: 'assistant_message',
        id: 'assistant-1',
        text: 'Hi',
        created_at: createdAt,
      },
    ]

    for (const unsafe of [
      event({
        type: 'text',
        item_id: 'assistant-1',
        delta: '!',
        start_offset: 3,
        end_offset: 4,
      }),
      event({
        type: 'text',
        item_id: 'assistant-1',
        delta: '!',
        start_offset: 2,
        end_offset: 5,
      }),
      event({ type: 'text', item_id: 'assistant-1', delta: '!' }),
    ]) {
      expect(applyConversationEventToItems(items, unsafe)).toBe(items)
    }
  })

  it('streams reasoning summary and content independently', () => {
    const items: ConversationItem[] = [
      {
        kind: 'reasoning',
        id: 'reasoning-1',
        summary: 'Checking',
        content: 'Inspect',
        created_at: createdAt,
      },
    ]
    const withSummary = applyConversationEventToItems(
      items,
      event({
        type: 'text',
        item_id: 'reasoning-1',
        delta: ' files',
        target: 'reasoning_summary',
        start_offset: 8,
        end_offset: 14,
      }),
    )
    const withContent = applyConversationEventToItems(
      withSummary,
      event({
        type: 'text',
        item_id: 'reasoning-1',
        delta: ' files',
        target: 'reasoning_content',
        start_offset: 7,
        end_offset: 13,
      }),
    )

    expect(withContent[0]).toMatchObject({
      summary: 'Checking files',
      content: 'Inspect files',
      lifecycle: 'streaming',
    })
  })

  it('streams tool output once and marks the command running', () => {
    const items: ConversationItem[] = [
      {
        kind: 'tool_call',
        id: 'command-1',
        title: 'npm test',
        tool_kind: 'commandExecution',
        status: 'running',
        output: 'Pass ',
        exit_code: null,
        display: {
          is_read_only: false,
          has_side_effect: true,
          is_error: false,
          lifecycle: 'queued',
          artifact_kind: 'command_output',
          activity_kind: 'test',
          history_mode: 'full',
          summary_hint: null,
        },
        created_at: createdAt,
        completed_at: null,
      },
    ]
    const delta = event({
      type: 'text',
      item_id: 'command-1',
      delta: '🙂',
      target: 'tool_output',
      start_offset: 5,
      end_offset: 7,
    })

    const applied = applyConversationEventToItems(items, delta)
    expect(applied[0]).toMatchObject({
      output: 'Pass 🙂',
      status: 'running',
      display: { lifecycle: 'running' },
    })
    expect(applyConversationEventToItems(applied, delta)).toBe(applied)
  })

  it('streams plan text idempotently before structured steps arrive', () => {
    const items: ConversationItem[] = [
      {
        kind: 'plan',
        id: 'plan-1',
        plan: { explanation: 'Audit ', steps: [] },
        created_at: createdAt,
      },
    ]
    const delta = event({
      type: 'text',
      item_id: 'plan-1',
      delta: 'iOS 🙂',
      target: 'plan_explanation',
      start_offset: 6,
      end_offset: 12,
    })
    const applied = applyConversationEventToItems(items, delta)
    expect(applied[0]).toMatchObject({ plan: { explanation: 'Audit iOS 🙂' } })
    expect(applyConversationEventToItems(applied, delta)).toBe(applied)
  })

  it('appends a delayed delta without reopening terminal assistant content', () => {
    const items: ConversationItem[] = [
      {
        kind: 'assistant_message',
        id: 'assistant-terminal',
        text: 'Partial',
        lifecycle: 'interrupted',
        created_at: createdAt,
      },
    ]
    const applied = applyConversationEventToItems(
      items,
      event({
        type: 'text',
        item_id: 'assistant-terminal',
        delta: ' answer',
        target: 'assistant_text',
        start_offset: 7,
        end_offset: 14,
      }),
    )

    expect(applied[0]).toMatchObject({
      text: 'Partial answer',
      lifecycle: 'interrupted',
    })
  })
})
