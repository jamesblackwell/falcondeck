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

    expect(hook.value.showJumpButton).toBe(false)
    expect(hook.scrollToEnd).not.toHaveBeenCalled()
  })

  it('leaves FlashList autoscroll disabled so its sticky near-bottom flag never fires', () => {
    const hook = renderHook()
    expect(hook.value.autoscrollToBottomThreshold).toBeLessThan(0)

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(500))
    })
    expect(hook.value.autoscrollToBottomThreshold).toBeLessThan(0)
  })

  it('pins to the tail as content grows while following', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onContentSizeChange()
    })

    expect(hook.scrollToEnd).toHaveBeenCalledWith({ animated: true })
  })

  it('stops pinning the moment a drag starts, however much content arrives', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(500))
    })
    act(() => {
      hook.value.onContentSizeChange()
      hook.value.onContentSizeChange()
    })

    expect(hook.scrollToEnd).not.toHaveBeenCalled()
  })

  it('does not resume following when a drag ends after a net upward pull, even near the bottom', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(500))
      hook.value.onScrollEndDrag(scrollEvent(480))
    })

    act(() => {
      hook.value.onContentSizeChange()
    })
    expect(hook.scrollToEnd).not.toHaveBeenCalled()
  })

  it('resumes following when a drag ends near the bottom without pulling up', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(300))
      hook.value.onScrollEndDrag(scrollEvent(490))
    })

    expect(hook.scrollToEnd).toHaveBeenCalledWith({ animated: true })
  })

  it('does not resume following when a drag ends away from the bottom', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(100))
      hook.value.onScrollEndDrag(scrollEvent(200))
    })

    expect(hook.scrollToEnd).not.toHaveBeenCalled()
  })

  it('resumes following when momentum settles at the bottom', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(100))
      hook.value.onScrollEndDrag(scrollEvent(200))
      hook.value.onMomentumScrollEnd(scrollEvent(495))
    })

    expect(hook.scrollToEnd).toHaveBeenCalledWith({ animated: true })
  })

  it('leaves following off when momentum settles mid-list', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(400))
      hook.value.onScrollEndDrag(scrollEvent(300))
      hook.value.onMomentumScrollEnd(scrollEvent(150))
    })

    expect(hook.scrollToEnd).not.toHaveBeenCalled()
  })

  it('re-arms following via the jump button and on thread reset', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(500))
    })
    act(() => {
      hook.value.scrollToBottom()
    })
    act(() => {
      hook.value.onContentSizeChange()
    })
    expect(hook.scrollToEnd).toHaveBeenCalledTimes(2)

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(500))
    })
    act(() => {
      hook.value.resetScrollState()
      hook.value.onContentSizeChange()
    })
    expect(hook.scrollToEnd).toHaveBeenCalledTimes(3)
  })

  it('snaps a send to the tail when the reader is hovering just above it', () => {
    const hook = renderHook()

    // Scrolled up a little — not following, but the jump button is not showing.
    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(500))
      hook.value.onScrollEndDrag(scrollEvent(350))
    })
    expect(hook.value.showJumpButton).toBe(false)

    act(() => {
      hook.value.scrollToBottomIfNear()
    })
    expect(hook.scrollToEnd).toHaveBeenCalledWith({ animated: true })

    // Re-armed: streamed content keeps pinning.
    act(() => {
      hook.value.onContentSizeChange()
    })
    expect(hook.scrollToEnd).toHaveBeenCalledTimes(2)
  })

  it('leaves a send alone for a reader deep enough that the jump button shows', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(500))
      hook.value.onScrollEndDrag(scrollEvent(100))
      hook.value.onScroll(scrollEvent(100))
    })
    expect(hook.value.showJumpButton).toBe(true)

    act(() => {
      hook.value.scrollToBottomIfNear()
      hook.value.onContentSizeChange()
    })
    expect(hook.scrollToEnd).not.toHaveBeenCalled()
  })

  it('snaps a refreshed thread to the tail only for a reader who has not scrolled away', () => {
    const hook = renderHook()

    // Still at the tail: a detail refresh should land the reader on the newest
    // items it just merged in.
    act(() => {
      hook.value.scrollToBottomIfFollowing(false)
    })
    expect(hook.scrollToEnd).toHaveBeenCalledWith({ animated: false })

    // Scrolled back through the history: the same refresh — a reconnect, a
    // workspace reselect — must not drag them to the bottom.
    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(500))
      hook.value.onScrollEndDrag(scrollEvent(200))
    })
    act(() => {
      hook.value.scrollToBottomIfFollowing(false)
    })
    expect(hook.scrollToEnd).toHaveBeenCalledTimes(1)
  })
})
