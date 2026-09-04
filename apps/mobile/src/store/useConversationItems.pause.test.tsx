import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'

import { cleanup, renderComponent } from '@/test/render'

import { useConversationItems, useSessionStore } from './session-store'
import {
  assistantMessage,
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
})
