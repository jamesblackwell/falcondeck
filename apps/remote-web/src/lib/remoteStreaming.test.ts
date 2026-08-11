import { describe, expect, it } from 'vitest'

import type { EventEnvelope } from '@falcondeck/client-core'

import {
  applyDaemonEventsToThreadItems,
  bufferSnapshotRaceEvent,
  clearSnapshotRaceBuffer,
  collectConversationItemUpdates,
} from './remoteAppUtils'

const createdAt = '2026-08-08T20:00:00Z'

function envelope(seq: number, event: EventEnvelope['event']): EventEnvelope {
  return {
    seq,
    emitted_at: createdAt,
    workspace_id: 'workspace-1',
    thread_id: 'thread-1',
    event,
  }
}

describe('remote conversation streaming', () => {
  it('bounds and deduplicates events raced by a snapshot request', () => {
    const first = envelope(1, { type: 'start', title: 'First' })
    const second = envelope(2, { type: 'start', title: 'Second' })
    const buffer: EventEnvelope[] = []
    const seen = new Set<number>()

    expect(bufferSnapshotRaceEvent(buffer, seen, first, 1)).toBe(false)
    expect(bufferSnapshotRaceEvent(buffer, seen, first, 1)).toBe(false)
    expect(bufferSnapshotRaceEvent(buffer, seen, second, 1)).toBe(true)
    expect(buffer).toEqual([first])
    expect(seen).toEqual(new Set([1]))
  })

  it('preserves item/delta order and applies a frame as one state update', () => {
    const events = [
      envelope(1, {
        type: 'conversation-item-added',
        item: {
          kind: 'assistant_message',
          id: 'assistant-1',
          text: 'Hello',
          created_at: createdAt,
        },
      }),
      envelope(2, {
        type: 'text',
        item_id: 'assistant-1',
        delta: ' world',
        target: 'assistant_text',
        start_offset: 5,
        end_offset: 11,
      }),
    ]

    const { passthroughEvents, updatesByThread } =
      collectConversationItemUpdates(events)
    const state = applyDaemonEventsToThreadItems({}, updatesByThread)

    expect(passthroughEvents).toEqual([])
    expect(state['thread-1']?.[0]).toMatchObject({ text: 'Hello world' })
  })

  it('clears events buffered before an authoritative snapshot', () => {
    const buffer = [envelope(1, { type: 'start', title: 'stale' })]
    const seen = new Set([1])

    clearSnapshotRaceBuffer(buffer, seen)

    expect(buffer).toEqual([])
    expect(seen).toEqual(new Set())
  })

  it('preserves state identity when replay has already been applied', () => {
    const current = {
      'thread-1': [
        {
          kind: 'assistant_message' as const,
          id: 'assistant-1',
          text: 'Hello world',
          created_at: createdAt,
        },
      ],
    }
    const replay = envelope(2, {
      type: 'text',
      item_id: 'assistant-1',
      delta: ' world',
      target: 'assistant_text',
      start_offset: 5,
      end_offset: 11,
    })
    const { updatesByThread } = collectConversationItemUpdates([replay])

    expect(applyDaemonEventsToThreadItems(current, updatesByThread)).toBe(
      current,
    )
  })

  it('does not reopen interrupted content when its final text delta replays', () => {
    const current = {
      'thread-1': [
        {
          kind: 'assistant_message' as const,
          id: 'assistant-1',
          text: 'Partial answer',
          lifecycle: 'interrupted' as const,
          created_at: createdAt,
        },
      ],
    }
    const replay = envelope(3, {
      type: 'text',
      item_id: 'assistant-1',
      delta: 'Partial answer',
      target: 'assistant_text',
      start_offset: 0,
      end_offset: 14,
    })
    const { updatesByThread } = collectConversationItemUpdates([replay])

    const next = applyDaemonEventsToThreadItems(current, updatesByThread)
    expect(next).toBe(current)
    expect(next['thread-1']?.[0]).toMatchObject({ lifecycle: 'interrupted' })
  })

  it('retains interrupted lifecycle when a delayed delta adds missing text', () => {
    const current = {
      'thread-1': [
        {
          kind: 'assistant_message' as const,
          id: 'assistant-1',
          text: 'Partial',
          lifecycle: 'interrupted' as const,
          created_at: createdAt,
        },
      ],
    }
    const delayed = envelope(4, {
      type: 'text',
      item_id: 'assistant-1',
      delta: ' answer',
      target: 'assistant_text',
      start_offset: 7,
      end_offset: 14,
    })
    const { updatesByThread } = collectConversationItemUpdates([delayed])

    expect(
      applyDaemonEventsToThreadItems(current, updatesByThread)['thread-1']?.[0],
    ).toMatchObject({ text: 'Partial answer', lifecycle: 'interrupted' })
  })
})
