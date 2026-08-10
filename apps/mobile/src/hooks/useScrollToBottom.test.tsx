import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cleanup, renderComponent } from '@/test/render'

import { useScrollToBottom } from './useScrollToBottom'

afterEach(cleanup)

function scrollEvent(y: number, contentHeight = 1000, viewportHeight = 500) {
  return {
    nativeEvent: {
      contentOffset: { y },
      contentSize: { height: contentHeight },
      layoutMeasurement: { height: viewportHeight },
    },
  } as any
}

function renderHook() {
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
  return { get value() { return value! }, scrollToEnd }
}

describe('useScrollToBottom', () => {
  it('toggles the jump button based on distance from bottom and scrolls to end', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onScroll(scrollEvent(100))
    })
    expect(hook.value.showJumpButton).toBe(true)

    act(() => {
      hook.value.scrollToBottom(false)
    })
    expect(hook.scrollToEnd).toHaveBeenCalledWith({ animated: false })
    expect(hook.value.showJumpButton).toBe(false)
  })

  it('resets the jump button without touching scroll position', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onScroll(scrollEvent(0, 1000, 700))
    })
    expect(hook.value.showJumpButton).toBe(true)

    act(() => {
      hook.value.resetScrollState()
    })

    // Pinning to the bottom while content streams is FlashList's
    // maintainVisibleContentPosition job now; the hook must never scroll on
    // its own except for the explicit jump button.
    expect(hook.value.showJumpButton).toBe(false)
    expect(hook.scrollToEnd).not.toHaveBeenCalled()
  })

  it('drops the autoscroll threshold the moment a drag starts', () => {
    const hook = renderHook()
    expect(hook.value.autoscrollToBottomThreshold).toBe(0.2)

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(500))
    })
    expect(hook.value.autoscrollToBottomThreshold).toBe(0)
  })

  it('does not resume following when a drag ends after a net upward pull, even near the bottom', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(500))
      hook.value.onScrollEndDrag(scrollEvent(480))
    })

    expect(hook.value.autoscrollToBottomThreshold).toBe(0)
    expect(hook.scrollToEnd).not.toHaveBeenCalled()
  })

  it('resumes following when a drag ends near the bottom without pulling up', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(300))
      hook.value.onScrollEndDrag(scrollEvent(490))
    })

    expect(hook.value.autoscrollToBottomThreshold).toBe(0.2)
    expect(hook.scrollToEnd).toHaveBeenCalledWith({ animated: true })
  })

  it('does not resume following when a drag ends away from the bottom', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(100))
      hook.value.onScrollEndDrag(scrollEvent(200))
    })

    expect(hook.value.autoscrollToBottomThreshold).toBe(0)
    expect(hook.scrollToEnd).not.toHaveBeenCalled()
  })

  it('resumes following when momentum settles at the bottom', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(100))
      hook.value.onScrollEndDrag(scrollEvent(200))
      hook.value.onMomentumScrollEnd(scrollEvent(495))
    })

    expect(hook.value.autoscrollToBottomThreshold).toBe(0.2)
    expect(hook.scrollToEnd).toHaveBeenCalledWith({ animated: true })
  })

  it('leaves following off when momentum settles mid-list', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(400))
      hook.value.onScrollEndDrag(scrollEvent(300))
      hook.value.onMomentumScrollEnd(scrollEvent(150))
    })

    expect(hook.value.autoscrollToBottomThreshold).toBe(0)
    expect(hook.scrollToEnd).not.toHaveBeenCalled()
  })

  it('re-arms following via the jump button and on thread reset', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(500))
    })
    expect(hook.value.autoscrollToBottomThreshold).toBe(0)

    act(() => {
      hook.value.scrollToBottom()
    })
    expect(hook.value.autoscrollToBottomThreshold).toBe(0.2)

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(500))
    })
    act(() => {
      hook.value.resetScrollState()
    })
    expect(hook.value.autoscrollToBottomThreshold).toBe(0.2)
  })
})
