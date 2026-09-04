import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'

import { cleanup, renderComponent } from '@/test/render'

import {
  useConversationItems,
  useSelectedThreadHistory,
  useSessionStore,
} from './session-store'
import {
  assistantMessage,
  conversationItemAddedEvent,
  conversationItemUpdatedEvent,
  snapshot,
  snapshotEvent,
  thread,
} from '../test/factories'

afterEach(() => {
  cleanup()
  useSessionStore.getState().reset()
})

describe('useConversationItems pause', () => {
  it('keeps the paused snapshot while streaming chunks arrive, then catches up', () => {
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          threads: [thread({ id: 'thread-1', status: 'running' })],
        }),
      ),
    )
    useSessionStore.getState().applyDaemonEvent(
      conversationItemUpdatedEvent(assistantMessage('m1', 'Hel')),
    )

    const seen: string[][] = []
    function Harness({ pause }: { pause: boolean }) {
      const items = useConversationItems({ pause })
      seen.push(
        items.map((item) => (item.kind === 'assistant_message' ? item.text : item.id)),
      )
      return null
    }

    const renderer = renderComponent(<Harness pause={false} />)
    expect(seen.at(-1)).toEqual(['Hel'])

    act(() => {
      renderer.update(<Harness pause />)
    })
    const pausedAt = seen.length

    act(() => {
      useSessionStore.getState().applyDaemonEvent(
        conversationItemUpdatedEvent(assistantMessage('m1', 'Hello')),
      )
    })
    expect(seen.length).toBe(pausedAt)
    expect(seen.at(-1)).toEqual(['Hel'])
    expect(useSessionStore.getState().threadItems['thread-1']?.[0]).toMatchObject({
      text: 'Hello',
    })

    act(() => {
      renderer.update(<Harness pause={false} />)
    })
    expect(seen.at(-1)).toEqual(['Hello'])
  })

  it('freezes history metadata with the hidden transcript', () => {
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          threads: [thread({ id: 'thread-1', status: 'running' })],
        }),
      ),
    )
    useSessionStore.getState().applyDaemonEvent(
      conversationItemAddedEvent(assistantMessage('m1', 'First')),
    )

    const seen: Array<string | null> = []
    function Harness({ pause }: { pause: boolean }) {
      seen.push(useSelectedThreadHistory({ pause }).newestItemId)
      return null
    }

    const renderer = renderComponent(<Harness pause={false} />)
    expect(seen.at(-1)).toBe('m1')

    act(() => renderer.update(<Harness pause />))
    const pausedAt = seen.length
    act(() => {
      useSessionStore.getState().applyDaemonEvent(
        conversationItemAddedEvent(assistantMessage('m2', 'Second')),
      )
    })
    expect(seen.length).toBe(pausedAt)

    act(() => renderer.update(<Harness pause={false} />))
    expect(seen.at(-1)).toBe('m2')
  })
})
