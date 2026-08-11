import { describe, expect, it } from 'vitest'

import {
  contentLifecycle,
  contentLifecycleLabel,
  normalizeConversationItem,
  type ConversationItem,
} from '@falcondeck/client-core'

const createdAt = '2026-08-08T20:00:00Z'

describe('content lifecycle normalization', () => {
  it('hydrates legacy assistant, reasoning, image, and web-search history as complete', () => {
    const legacy: ConversationItem[] = [
      { kind: 'assistant_message', id: 'a1', text: 'Done', created_at: createdAt },
      { kind: 'reasoning', id: 'r1', summary: null, content: 'Done', created_at: createdAt },
      {
        kind: 'image',
        id: 'i1',
        title: 'Generated image',
        image: { id: 'asset-1', url: 'https://example.com/image.png' },
        created_at: createdAt,
      },
      {
        kind: 'web_search',
        id: 's1',
        search: {
          id: 's1-search',
          query: 'FalconDeck',
          action_kind: 'search',
          queries: [],
          url: null,
          pattern: null,
        },
        created_at: createdAt,
      },
    ]

    expect(legacy.map((item) => contentLifecycle(normalizeConversationItem(item) as typeof item)))
      .toEqual(['complete', 'complete', 'complete', 'complete'])
  })

  it('keeps explicit lifecycle from a newer daemon', () => {
    const item: ConversationItem = {
      kind: 'assistant_message',
      id: 'a1',
      text: 'Partial',
      lifecycle: 'interrupted',
      created_at: createdAt,
    }
    expect(normalizeConversationItem(item)).toMatchObject({ lifecycle: 'interrupted' })
  })

  it('does not strip explicit tool lifecycle metadata during normalization', () => {
    const item: ConversationItem = {
      kind: 'tool_call',
      id: 'tool-1',
      title: 'Provider tool',
      tool_kind: 'other',
      status: 'provider_magic',
      output: null,
      exit_code: null,
      display: {
        is_read_only: false,
        has_side_effect: false,
        is_error: false,
        lifecycle: 'interrupted',
        artifact_kind: 'none',
        activity_kind: 'other',
        history_mode: 'full',
        summary_hint: null,
      },
      created_at: createdAt,
      completed_at: createdAt,
    }
    expect((normalizeConversationItem(item) as typeof item).display.lifecycle).toBe('interrupted')
  })

  it('provides stable user-facing labels', () => {
    expect(['pending', 'streaming', 'complete', 'interrupted', 'error'].map((value) =>
      contentLifecycleLabel(value as Parameters<typeof contentLifecycleLabel>[0]),
    )).toEqual(['Pending', 'Streaming', 'Complete', 'Interrupted', 'Failed'])
  })
})
