import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cleanup, renderComponent } from '@/test/render'

import { useSessionStore, useThrottledSnapshot } from './session-store'
import { snapshot, thread, snapshotEvent, threadUpdatedEvent } from '../test/factories'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useSessionStore.getState().reset()
})

const INTERVAL_MS = 250

function renderHarness() {
  const renders: (string | undefined)[] = []

  function Harness() {
    const value = useThrottledSnapshot(INTERVAL_MS)
    renders.push(value?.threads[0]?.title)
    return null
  }

  renderComponent(<Harness />)
  return renders
}

describe('useThrottledSnapshot', () => {
  it('samples a burst of snapshot changes once per interval', () => {
    vi.useFakeTimers()
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(snapshot({ threads: [thread({ id: 't1', title: 'first' })] })),
    )

    const renders = renderHarness()
    expect(renders.at(-1)).toBe('first')
    const rendersAfterMount = renders.length

    // A streaming turn replaces the snapshot far faster than the interval.
    act(() => {
      for (let index = 0; index < 20; index += 1) {
        useSessionStore
          .getState()
          .applyDaemonEvent(threadUpdatedEvent(thread({ id: 't1', title: `chunk-${index}` })))
      }
    })
    // The burst itself must not repaint per event.
    expect(renders.length).toBe(rendersAfterMount)

    act(() => {
      vi.advanceTimersByTime(INTERVAL_MS)
    })
    // One repaint, holding the newest value rather than a queued stale one.
    expect(renders.length).toBe(rendersAfterMount + 1)
    expect(renders.at(-1)).toBe('chunk-19')
  })

  it('delivers a trailing change that lands inside the window', () => {
    vi.useFakeTimers()
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(snapshot({ threads: [thread({ id: 't1', title: 'first' })] })),
    )
    const renders = renderHarness()

    act(() => {
      useSessionStore
        .getState()
        .applyDaemonEvent(threadUpdatedEvent(thread({ id: 't1', title: 'last' })))
    })
    act(() => {
      vi.advanceTimersByTime(INTERVAL_MS)
    })

    expect(renders.at(-1)).toBe('last')
  })

  it('stops sampling once unmounted', () => {
    vi.useFakeTimers()
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(snapshot({ threads: [thread({ id: 't1', title: 'first' })] })),
    )
    const renders = renderHarness()
    const beforeUnmount = renders.length

    cleanup()
    act(() => {
      useSessionStore
        .getState()
        .applyDaemonEvent(threadUpdatedEvent(thread({ id: 't1', title: 'after' })))
      vi.advanceTimersByTime(INTERVAL_MS * 4)
    })

    expect(renders.length).toBe(beforeUnmount)
  })
})
