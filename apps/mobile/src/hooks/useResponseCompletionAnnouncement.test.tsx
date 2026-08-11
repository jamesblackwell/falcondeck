import React from 'react'
import { act, type ReactTestRenderer } from 'react-test-renderer'
import type { AppStateStatus } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ConversationItem } from '@falcondeck/client-core'

import { cleanup, renderComponent } from '@/test/render'
import { useResponseCompletionAnnouncement } from './useResponseCompletionAnnouncement'

type HarnessProps = {
  threadKey: string | null
  status: string | null
  items: ConversationItem[]
  appState: AppStateStatus
  onComplete: () => void
}

function Harness(props: HarnessProps) {
  useResponseCompletionAnnouncement(props)
  return null
}

function renderHarness(initialProps: HarnessProps) {
  const renderer = renderComponent(<Harness {...initialProps} />)
  return {
    rerender(nextProps: HarnessProps) {
      act(() => renderer.update(<Harness {...nextProps} />))
    },
    renderer: renderer as ReactTestRenderer,
  }
}

const assistant = (
  id: string,
  lifecycle: 'streaming' | 'complete' | 'interrupted' | 'error',
): ConversationItem => ({
  kind: 'assistant_message',
  id,
  text: `${id} ${lifecycle}`,
  lifecycle,
  created_at: '2026-08-09T12:00:00Z',
})

afterEach(cleanup)

describe('useResponseCompletionAnnouncement', () => {
  it('announces after content and turn state have both settled', () => {
    const onComplete = vi.fn()
    const { rerender } = renderHarness({
      threadKey: 'thread-1',
      status: 'running',
      items: [assistant('answer-1', 'streaming')],
      appState: 'active',
      onComplete,
    })

    rerender({
      threadKey: 'thread-1',
      status: 'running',
      items: [assistant('answer-1', 'complete')],
      appState: 'active',
      onComplete,
    })
    expect(onComplete).not.toHaveBeenCalled()

    rerender({
      threadKey: 'thread-1',
      status: 'idle',
      items: [assistant('answer-1', 'complete')],
      appState: 'active',
      onComplete,
    })
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('handles thread state settling before assistant lifecycle', () => {
    const onComplete = vi.fn()
    const { rerender } = renderHarness({
      threadKey: 'thread-1',
      status: 'running',
      items: [assistant('answer-1', 'streaming')],
      appState: 'active',
      onComplete,
    })

    rerender({
      threadKey: 'thread-1',
      status: 'idle',
      items: [assistant('answer-1', 'streaming')],
      appState: 'active',
      onComplete,
    })
    rerender({
      threadKey: 'thread-1',
      status: 'idle',
      items: [assistant('answer-1', 'complete')],
      appState: 'active',
      onComplete,
    })

    expect(onComplete).toHaveBeenCalledOnce()
  })

  it.each(['interrupted', 'error'] as const)(
    'does not announce a %s response as complete',
    (lifecycle) => {
      const onComplete = vi.fn()
      const { rerender } = renderHarness({
        threadKey: 'thread-1',
        status: 'running',
        items: [assistant('answer-1', 'streaming')],
        appState: 'active',
        onComplete,
      })

      rerender({
        threadKey: 'thread-1',
        status: 'idle',
        items: [assistant('answer-1', lifecycle)],
        appState: 'active',
        onComplete,
      })

      expect(onComplete).not.toHaveBeenCalled()
    },
  )

  it('suppresses a completion after the turn was backgrounded', () => {
    const onComplete = vi.fn()
    const { rerender } = renderHarness({
      threadKey: 'thread-1',
      status: 'running',
      items: [assistant('answer-1', 'streaming')],
      appState: 'active',
      onComplete,
    })

    rerender({
      threadKey: 'thread-1',
      status: 'idle',
      items: [assistant('answer-1', 'complete')],
      appState: 'background',
      onComplete,
    })
    rerender({
      threadKey: 'thread-1',
      status: 'idle',
      items: [assistant('answer-1', 'complete')],
      appState: 'active',
      onComplete,
    })

    expect(onComplete).not.toHaveBeenCalled()
  })

  it('does not announce completed history after a thread switch', () => {
    const onComplete = vi.fn()
    const { rerender } = renderHarness({
      threadKey: 'thread-1',
      status: 'idle',
      items: [assistant('answer-1', 'complete')],
      appState: 'active',
      onComplete,
    })

    rerender({
      threadKey: 'thread-2',
      status: 'idle',
      items: [assistant('answer-2', 'complete')],
      appState: 'active',
      onComplete,
    })

    expect(onComplete).not.toHaveBeenCalled()
  })
})
