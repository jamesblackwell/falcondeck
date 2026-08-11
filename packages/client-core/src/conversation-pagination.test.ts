import { describe, expect, it } from 'vitest'

import { applyConversationEventsToItems, mergeThreadDetailPage } from './conversation'
import type { ConversationItem, EventEnvelope, ThreadDetail } from './types'

const at = '2026-08-09T12:00:00Z'

function assistant(id: string, text = id): ConversationItem {
  return {
    kind: 'assistant_message',
    id,
    text,
    phase: 'final_answer',
    memory_citation: null,
    citations: [],
    lifecycle: 'complete',
    created_at: at,
  }
}

function assistantWithLifecycle(
  id: string,
  text: string,
  lifecycle: 'streaming' | 'interrupted',
): ConversationItem {
  return { ...assistant(id, text), lifecycle }
}

function detail(
  ids: string[],
  options: { hasOlder?: boolean; threadId?: string; text?: Record<string, string> } = {},
): ThreadDetail {
  const items = ids.map((id) => assistant(id, options.text?.[id] ?? id))
  return {
    workspace: { id: 'workspace-1' },
    thread: { id: options.threadId ?? 'thread-1' },
    items,
    has_older: options.hasOlder ?? false,
    oldest_item_id: items[0]?.id ?? null,
    newest_item_id: items.at(-1)?.id ?? null,
    is_partial: options.hasOlder ?? false,
  } as ThreadDetail
}

describe('mergeThreadDetailPage', () => {
  it('prepends an overlapping older page once and adopts its history boundary', () => {
    const current = detail(['b', 'c', 'd'], { hasOlder: true })
    const page = detail(['a', 'b'], { hasOlder: false, text: { b: 'authoritative b' } })

    const merged = mergeThreadDetailPage(current, page, 'prepend')

    expect(merged.items.map((item) => `${item.id}:${item.kind === 'assistant_message' ? item.text : ''}`))
      .toEqual(['a:a', 'b:authoritative b', 'c:c', 'd:d'])
    expect(merged.has_older).toBe(false)
    expect(merged.is_partial).toBe(false)
    expect(merged.oldest_item_id).toBe('a')
    expect(merged.newest_item_id).toBe('d')
  })

  it('replaces the authoritative tail while preserving a continuous loaded prefix', () => {
    const current = detail(['a', 'b', 'c', 'stale'], { hasOlder: false })
    const page = detail(['c', 'd'], { hasOlder: true, text: { c: 'updated c' } })

    const merged = mergeThreadDetailPage(current, page, 'refresh')

    expect(merged.items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(merged.items[2]).toMatchObject({ text: 'updated c' })
    expect(merged.has_older).toBe(false)
    expect(merged.is_partial).toBe(false)
  })

  it('trusts a fresh non-overlapping tail instead of joining unrelated history', () => {
    const merged = mergeThreadDetailPage(
      detail(['old-a', 'old-b'], { hasOlder: true }),
      detail(['new-a', 'new-b'], { hasOlder: true }),
      'refresh',
    )

    expect(merged.items.map((item) => item.id)).toEqual(['new-a', 'new-b'])
    expect(merged.has_older).toBe(true)
  })

  it('adopts an interrupted authoritative tail without duplicating partial content', () => {
    const current = detail(['user-boundary', 'answer'], {
      text: { answer: 'Partial answer retained across reconnect.' },
    })
    current.items[1] = assistantWithLifecycle(
      'answer',
      'Partial answer retained across reconnect.',
      'streaming',
    )
    const page = detail(['user-boundary', 'answer'])
    page.items[1] = assistantWithLifecycle(
      'answer',
      'Partial answer retained across reconnect.',
      'interrupted',
    )

    const merged = mergeThreadDetailPage(current, page, 'refresh')

    expect(merged.items.map((item) => item.id)).toEqual(['user-boundary', 'answer'])
    expect(merged.items[1]).toMatchObject({
      text: 'Partial answer retained across reconnect.',
      lifecycle: 'interrupted',
    })
  })

  it('replaces a cached truncated tail and treats retained delta replay as a no-op', () => {
    const cached = detail(['user', 'answer'], {
      text: { answer: 'Cached partial answer' },
    })
    cached.items[1] = assistantWithLifecycle('answer', 'Cached partial answer', 'streaming')
    const authoritative = detail(['user', 'answer', 'next'], {
      text: {
        answer: 'Authoritative complete response.',
        next: 'Retained update recovered once.',
      },
    })
    const merged = mergeThreadDetailPage(cached, authoritative, 'refresh')
    const suffix = 'response.'
    const completeText = 'Authoritative complete response.'
    const replay: EventEnvelope = {
      seq: 42,
      emitted_at: at,
      workspace_id: 'workspace-1',
      thread_id: 'thread-1',
      event: {
        type: 'text',
        item_id: 'answer',
        delta: suffix,
        start_offset: completeText.length - suffix.length,
        end_offset: completeText.length,
      },
    }

    const afterReplay = applyConversationEventsToItems(merged.items, [replay, replay])

    expect(merged.items.map((item) => item.id)).toEqual(['user', 'answer', 'next'])
    expect(afterReplay).toBe(merged.items)
    expect(afterReplay.filter((item) => item.id === 'answer')).toHaveLength(1)
    expect(afterReplay[1]).toMatchObject({
      text: completeText,
      lifecycle: 'complete',
    })
  })

  it('never merges pages belonging to different threads', () => {
    const page = detail(['other'], { threadId: 'thread-2' })
    expect(mergeThreadDetailPage(detail(['current']), page, 'prepend')).toBe(page)
  })
})
