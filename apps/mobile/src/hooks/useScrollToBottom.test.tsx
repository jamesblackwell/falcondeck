import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cleanup, renderComponent } from '@/test/render'

import { useScrollToBottom } from './useScrollToBottom'

afterEach(cleanup)

describe('useScrollToBottom', () => {
  it('toggles the jump button based on distance from bottom and scrolls to end', () => {
    let value: ReturnType<typeof useScrollToBottom<string>> | null = null

    function Harness() {
      value = useScrollToBottom<string>()
      return null
    }

    renderComponent(<Harness />)
    const scrollToEnd = vi.fn()
    value!.listRef.current = {
      scrollToEnd,
      scrollToOffset: vi.fn(),
    } as any

    act(() => {
      value!.onScroll({
        nativeEvent: {
          contentOffset: { y: 100 },
          contentSize: { height: 1000 },
          layoutMeasurement: { height: 500 },
        },
      } as any)
    })
    expect(value!.showJumpButton).toBe(true)

    act(() => {
      value!.scrollToBottom(false)
    })
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false })
    expect(value!.showJumpButton).toBe(false)

    act(() => {
      value!.onContentSizeChange()
    })
    expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: false })
  })

  it('does not auto-scroll new content when the user is away from the bottom', () => {
    let value: ReturnType<typeof useScrollToBottom<string>> | null = null

    function Harness() {
      value = useScrollToBottom<string>()
      return null
    }

    renderComponent(<Harness />)
    const scrollToEnd = vi.fn()
    value!.listRef.current = {
      scrollToEnd,
      scrollToOffset: vi.fn(),
    } as any

    act(() => {
      value!.onScroll({
        nativeEvent: {
          contentOffset: { y: 0 },
          contentSize: { height: 1000 },
          layoutMeasurement: { height: 700 },
        },
      } as any)
    })

    expect(value!.showJumpButton).toBe(true)

    act(() => {
      value!.onContentSizeChange()
    })

    expect(scrollToEnd).not.toHaveBeenCalled()
  })
})
