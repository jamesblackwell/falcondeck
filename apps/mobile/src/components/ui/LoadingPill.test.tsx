import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cleanup, renderComponent, textOf } from '@/test/render'
import { LOADING_PILL_SHOW_AFTER_MS, LoadingPill } from './LoadingPill'

describe('LoadingPill', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('waits before announcing a load and hides as soon as it settles', () => {
    const renderer = renderComponent(
      <LoadingPill visible label="Loading tasks…" accessibilityLabel="Loading tasks" />,
    )
    expect(textOf(renderer)).not.toContain('Loading tasks')
    act(() => {
      vi.advanceTimersByTime(LOADING_PILL_SHOW_AFTER_MS + 50)
    })
    expect(textOf(renderer)).toContain('Loading tasks…')

    act(() => {
      renderer.update(
        <LoadingPill visible={false} label="Loading tasks…" accessibilityLabel="Loading tasks" />,
      )
    })
    expect(textOf(renderer)).not.toContain('Loading tasks')
  })

  it('never shows when the load finishes inside the grace period', () => {
    const renderer = renderComponent(
      <LoadingPill visible label="Loading tasks…" />,
    )
    act(() => {
      vi.advanceTimersByTime(LOADING_PILL_SHOW_AFTER_MS - 50)
      renderer.update(<LoadingPill visible={false} label="Loading tasks…" />)
      vi.advanceTimersByTime(LOADING_PILL_SHOW_AFTER_MS)
    })
    expect(textOf(renderer)).not.toContain('Loading tasks')
  })
})
