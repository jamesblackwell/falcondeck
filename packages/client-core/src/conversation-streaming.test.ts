import { describe, expect, it } from 'vitest'

import { applyConversationEventToItems, assistantFailureDetail, toolLifecycle } from './conversation'
import type { ConversationItem, EventEnvelope, ToolLifecycle } from './types'

const createdAt = '2026-08-10T12:00:00Z'

function envelope(event: EventEnvelope['event']): EventEnvelope {
  return {
    seq: 1,
    emitted_at: createdAt,
    workspace_id: 'workspace-1',
    thread_id: 'thread-1',
    event,
  }
}

describe('terminal lifecycle under late text replay', () => {
  it.each(['complete', 'interrupted', 'error'] as const)(
    'appends missing assistant evidence without reopening %s content',
    (lifecycle) => {
      const items: ConversationItem[] = [
        {
          kind: 'assistant_message',
          id: 'assistant-1',
          text: 'Partial',
          lifecycle,
          created_at: createdAt,
        },
      ]

      const next = applyConversationEventToItems(
        items,
        envelope({
          type: 'text',
          item_id: 'assistant-1',
          delta: ' tail',
          target: 'assistant_text',
          start_offset: 7,
          end_offset: 12,
        }),
      )

      expect(next[0]).toMatchObject({ text: 'Partial tail', lifecycle })
    },
  )

  it.each(['complete', 'interrupted', 'error'] as const)(
    'appends missing reasoning evidence without reopening %s content',
    (lifecycle) => {
      const items: ConversationItem[] = [
        {
          kind: 'reasoning',
          id: 'reasoning-1',
          summary: 'Why',
          content: 'Think',
          lifecycle,
          created_at: createdAt,
        },
      ]

      const next = applyConversationEventToItems(
        items,
        envelope({
          type: 'text',
          item_id: 'reasoning-1',
          delta: ' more',
          target: 'reasoning_content',
          start_offset: 5,
          end_offset: 10,
        }),
      )

      expect(next[0]).toMatchObject({ content: 'Think more', lifecycle })
    },
  )

  it.each([
    ['completed', 0, 'succeeded'],
    ['failed', 1, 'failed'],
    ['denied', null, 'denied'],
    ['interrupted', null, 'interrupted'],
  ] as const)(
    'retains terminal tool state %s when late output arrives',
    (status, exitCode, expectedLifecycle) => {
      const display = {
        is_read_only: false,
        has_side_effect: true,
        is_error: expectedLifecycle === 'failed',
        lifecycle: 'unknown' as ToolLifecycle,
        artifact_kind: 'command_output' as const,
        activity_kind: 'command' as const,
        history_mode: 'full' as const,
        summary_hint: null,
      }
      const items: ConversationItem[] = [
        {
          kind: 'tool_call',
          id: 'command-1',
          title: 'npm test',
          tool_kind: 'commandExecution',
          status,
          output: 'Pass',
          exit_code: exitCode,
          display,
          created_at: createdAt,
          completed_at: createdAt,
        },
      ]

      expect(
        toolLifecycle(
          items[0] as Extract<ConversationItem, { kind: 'tool_call' }>,
        ),
      ).toBe(expectedLifecycle)
      const next = applyConversationEventToItems(
        items,
        envelope({
          type: 'text',
          item_id: 'command-1',
          delta: '\nlate',
          target: 'tool_output',
          start_offset: 4,
          end_offset: 9,
        }),
      )

      expect(next[0]).toMatchObject({
        output: 'Pass\nlate',
        status,
        display: { lifecycle: 'unknown' },
      })
      expect(
        (next[0] as Extract<ConversationItem, { kind: 'tool_call' }>).display,
      ).toBe(display)
    },
  )

  it('still promotes genuinely active content to streaming state', () => {
    const items: ConversationItem[] = [
      {
        kind: 'assistant_message',
        id: 'assistant-1',
        text: 'Live',
        lifecycle: 'pending',
        created_at: createdAt,
      },
    ]

    const next = applyConversationEventToItems(
      items,
      envelope({
        type: 'text',
        item_id: 'assistant-1',
        delta: ' now',
        target: 'assistant_text',
        start_offset: 4,
        end_offset: 8,
      }),
    )

    expect(next[0]).toMatchObject({ text: 'Live now', lifecycle: 'streaming' })
  })
})

// Claude and ACP re-emit whole items with a fresh created_at on every
// update; identity must win over timestamps or transcripts duplicate and
// reorder mid-turn (the Codex path streams offsets and never trips this).
describe('upsert identity beats re-stamped timestamps', () => {
  const assistant = (created_at: string, text: string): ConversationItem => ({
    kind: 'assistant_message',
    id: 'assistant-1',
    text,
    lifecycle: 'streaming',
    created_at,
  })
  const tool = (created_at: string, status: string): ConversationItem => ({
    kind: 'tool_call',
    id: 'tool-1',
    title: 'Read file',
    tool_kind: 'read',
    status,
    output: null,
    exit_code: null,
    display: {
      is_read_only: true,
      has_side_effect: false,
      is_error: false,
      lifecycle: status === 'completed' ? 'succeeded' : 'running',
      artifact_kind: 'none',
      activity_kind: 'read',
      history_mode: 'summary',
      summary_hint: 'Read file',
    },
    detail: null,
    created_at,
    completed_at: null,
  })

  it('does not duplicate an earlier item updated with a newer timestamp', () => {
    const items = [assistant('2026-08-10T12:00:00Z', 'Let me check'), tool('2026-08-10T12:00:01Z', 'running')]

    const next = applyConversationEventToItems(
      items,
      envelope({
        type: 'conversation-item-updated',
        item: assistant('2026-08-10T12:00:02Z', 'Let me check the file'),
      }),
    )

    expect(next).toHaveLength(2)
    expect(next[0]).toMatchObject({ id: 'assistant-1', text: 'Let me check the file' })
    expect(next[1]).toMatchObject({ id: 'tool-1' })
  })

  it('keeps an updated item anchored at its original position', () => {
    const items = [
      tool('2026-08-10T12:00:00Z', 'running'),
      assistant('2026-08-10T12:00:01Z', 'Reading'),
    ]

    const next = applyConversationEventToItems(
      items,
      envelope({
        type: 'conversation-item-updated',
        item: tool('2026-08-10T12:00:05Z', 'completed'),
      }),
    )

    expect(next.map((item) => item.id)).toEqual(['tool-1', 'assistant-1'])
    expect(next[0]).toMatchObject({ status: 'completed', created_at: '2026-08-10T12:00:00Z' })
  })

  it('still appends genuinely new items in timestamp order', () => {
    const items = [assistant('2026-08-10T12:00:00Z', 'Hello')]

    const next = applyConversationEventToItems(
      items,
      envelope({
        type: 'conversation-item-added',
        item: tool('2026-08-10T12:00:01Z', 'running'),
      }),
    )

    expect(next.map((item) => item.id)).toEqual(['assistant-1', 'tool-1'])
  })

  it('sorts a late historical item into place instead of appending it', () => {
    const items = [assistant('2026-08-10T12:00:05Z', 'Recent')]

    const next = applyConversationEventToItems(
      items,
      envelope({
        type: 'conversation-item-added',
        item: tool('2026-08-10T12:00:01Z', 'completed'),
      }),
    )

    expect(next.map((item) => item.id)).toEqual(['tool-1', 'assistant-1'])
  })
})

describe('assistantFailureDetail', () => {
  const item = (text: string, error?: string | null) =>
    ({
      kind: 'assistant_message',
      id: 'assistant-1',
      text,
      error,
      lifecycle: 'error',
      created_at: createdAt,
    }) as Extract<ConversationItem, { kind: 'assistant_message' }>

  it('returns the provider error when the body does not already carry it', () => {
    expect(assistantFailureDetail(item('', 'No endpoints available'))).toBe(
      'No endpoints available',
    )
  })

  it('suppresses the error detail when the body already contains it', () => {
    expect(
      assistantFailureDetail(
        item('Cannot read "image" (this model does not support image input)', 'Cannot read "image" (this model does not support image input)'),
      ),
    ).toBeNull()
  })

  it('returns null when there is no error', () => {
    expect(assistantFailureDetail(item('Failed.', null))).toBeNull()
  })
})
