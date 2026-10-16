import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cleanup, renderComponent } from '@/test/render'

import { AWAITING_TURN_START_MS, useAwaitingTurnStart } from './useAwaitingTurnStart'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

type Result = ReturnType<typeof useAwaitingTurnStart>

function mount(threadId: string | null, status: string | null) {
  const latest: { current: Result | null } = { current: null }
  function Probe(props: { threadId: string | null; status: string | null }) {
    latest.current = useAwaitingTurnStart(props.threadId, props.status)
    return null
  }
  const renderer = renderComponent(<Probe threadId={threadId} status={status} />)
  const update = (nextThreadId: string | null, nextStatus: string | null) =>
    act(() => renderer.update(<Probe threadId={nextThreadId} status={nextStatus} />))
  return { latest, update }
}

describe('useAwaitingTurnStart', () => {
  it('stays busy from acceptance until the thread reports a turn, then lets go', () => {
    const { latest, update } = mount('t1', 'idle')
    expect(latest.current?.isAwaiting).toBe(false)

    act(() => latest.current?.markAccepted())
    expect(latest.current?.isAwaiting).toBe(true)

    update('t1', 'running')
    expect(latest.current?.isAwaiting).toBe(false)

    // A fast turn back to idle must not bring the indicator back.
    update('t1', 'idle')
    expect(latest.current?.isAwaiting).toBe(false)
  })

  it('carries a new conversation onto the thread it creates', () => {
    const { latest, update } = mount(null, null)
    act(() => latest.current?.markAccepted())
    update('new-thread', 'idle')
    expect(latest.current?.isAwaiting).toBe(true)
  })

  it('does not follow the reader into another existing thread', () => {
    const { latest, update } = mount('t1', 'idle')
    act(() => latest.current?.markAccepted())
    update('t2', 'idle')
    expect(latest.current?.isAwaiting).toBe(false)
  })

  it('gives up if the agent never reports in', () => {
    vi.useFakeTimers()
    const { latest } = mount('t1', 'idle')
    act(() => latest.current?.markAccepted())
    act(() => {
      vi.advanceTimersByTime(AWAITING_TURN_START_MS)
    })
    expect(latest.current?.isAwaiting).toBe(false)
  })
})
