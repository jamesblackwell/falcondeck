import React from 'react'
import { Platform } from 'react-native'
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

function touchEvent(pageY: number) {
  return { nativeEvent: { identifier: 0, pageY } } as any
}

function renderHook() {
  let value: ReturnType<typeof useScrollToBottom<string>> | null = null

  function Harness() {
    value = useScrollToBottom<string>()
    return null
  }

  renderComponent(<Harness />)
  const scrollToEnd = vi.fn()
  const nativeScrollToEnd = vi.fn()
  const scrollToOffset = vi.fn()
  value!.listRef.current = {
    scrollToEnd,
    scrollToOffset,
    getNativeScrollRef: () => ({ scrollToEnd: nativeScrollToEnd }),
  } as any
  return {
    get value() {
      return value!
    },
    scrollToEnd,
    nativeScrollToEnd,
    scrollToOffset,
  }
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
    expect(hook.nativeScrollToEnd).toHaveBeenCalledWith({ animated: false })
    expect(hook.scrollToEnd).not.toHaveBeenCalled()
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
    expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
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

    expect(hook.nativeScrollToEnd).toHaveBeenCalledWith({ animated: false })
    expect(hook.scrollToEnd).not.toHaveBeenCalled()
  })

  it('waits for the native scroller instead of queuing uncancellable FlashList work', () => {
    const hook = renderHook()
    hook.value.listRef.current = {
      scrollToEnd: hook.scrollToEnd,
      scrollToOffset: hook.scrollToOffset,
      getNativeScrollRef: () => null,
    } as any

    act(() => {
      hook.value.onContentSizeChange()
    })

    expect(hook.scrollToEnd).not.toHaveBeenCalled()
  })

  it('cancels an in-flight glide the moment a drag starts', () => {
    const hook = renderHook()

    act(() => {
      hook.value.scrollToBottom()
    })
    expect(hook.nativeScrollToEnd).toHaveBeenCalledWith({ animated: true })

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(420))
    })
    expect(hook.scrollToOffset).toHaveBeenCalledWith({
      offset: 420,
      animated: false,
    })

    act(() => {
      hook.value.onContentSizeChange()
    })
    expect(hook.nativeScrollToEnd).toHaveBeenCalledTimes(1)
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
    expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
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
    expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
  })

  it('does not re-arm following when an upward fling settles near the bottom', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(500))
      hook.value.onScrollEndDrag(scrollEvent(470))
      hook.value.onMomentumScrollEnd(scrollEvent(470))
    })

    expect(hook.scrollToEnd).not.toHaveBeenCalled()
    act(() => {
      hook.value.onContentSizeChange()
    })
    expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
  })

  it.each([4, 8])(
    'keeps a %ipx upward peek detached through momentum and refresh',
    (peek) => {
      const hook = renderHook()
      act(() => {
        hook.value.onScrollBeginDrag(scrollEvent(500))
        hook.value.onScrollEndDrag(scrollEvent(500 - peek))
        hook.value.onContentSizeChange()
        hook.value.onMomentumScrollEnd(scrollEvent(480))
        hook.value.scrollToBottomIfFollowing(false)
      })
      expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
    },
  )

  it('does not re-arm before an upward fling whose release has not moved yet', () => {
    const hook = renderHook()
    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(480))
      hook.value.onScrollEndDrag(scrollEvent(480))
      hook.value.onContentSizeChange()
      hook.value.onMomentumScrollEnd(scrollEvent(470))
      hook.value.onContentSizeChange()
    })
    expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
  })

  it('resumes following when a drag reaches the bottom without pulling up', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(300))
      hook.value.onScrollEndDrag(scrollEvent(500))
    })

    // Re-arm the flag only — do not animate shut the leftover gap.
    expect(hook.scrollToEnd).not.toHaveBeenCalled()
    act(() => {
      hook.value.onContentSizeChange()
    })
    expect(hook.nativeScrollToEnd).toHaveBeenCalledWith({ animated: false })
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
      hook.value.onMomentumScrollEnd(scrollEvent(500))
    })

    expect(hook.scrollToEnd).not.toHaveBeenCalled()
    act(() => {
      hook.value.onContentSizeChange()
    })
    expect(hook.nativeScrollToEnd).toHaveBeenCalledWith({ animated: false })
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
    expect(hook.scrollToEnd).not.toHaveBeenCalled()
    expect(hook.nativeScrollToEnd).toHaveBeenCalledTimes(2)

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(500))
    })
    act(() => {
      hook.value.resetScrollState()
      hook.value.onContentSizeChange()
    })
    expect(hook.nativeScrollToEnd).toHaveBeenCalledTimes(3)
  })

  it('forgets the old gesture after an explicit jump to the bottom', () => {
    const hook = renderHook()
    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(500))
      hook.value.onScrollEndDrag(scrollEvent(470))
      hook.value.scrollToBottom(false)
      // New content arrives before the native scroll catches up.
      hook.value.onScroll(scrollEvent(500, 1100))
      hook.value.onContentSizeChange()
    })
    expect(hook.nativeScrollToEnd).toHaveBeenCalledTimes(2)
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
    expect(hook.nativeScrollToEnd).toHaveBeenCalledWith({ animated: true })

    // Re-armed: streamed content keeps pinning instantly, not as a glide.
    act(() => {
      hook.value.onContentSizeChange()
    })
    expect(hook.scrollToEnd).not.toHaveBeenCalled()
    expect(hook.nativeScrollToEnd).toHaveBeenCalledWith({ animated: false })
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
    expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
  })

  it('snaps a refreshed thread to the tail only for a reader who has not scrolled away', () => {
    const hook = renderHook()

    // Still at the tail: a detail refresh should land the reader on the newest
    // items it just merged in.
    act(() => {
      hook.value.scrollToBottomIfFollowing(false)
    })
    expect(hook.nativeScrollToEnd).toHaveBeenCalledWith({ animated: false })
    expect(hook.scrollToEnd).not.toHaveBeenCalled()

    // Scrolled back through the history: the same refresh — a reconnect, a
    // workspace reselect — must not drag them to the bottom.
    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(500))
      hook.value.onScrollEndDrag(scrollEvent(200))
    })
    act(() => {
      hook.value.scrollToBottomIfFollowing(false)
    })
    expect(hook.nativeScrollToEnd).toHaveBeenCalledTimes(1)
  })

  it('does not snap back after a small upward peek that layout corrections disguise as a downward move', () => {
    const hook = renderHook()

    // At the tail: y=500, content=1000, viewport=500 → distance 0.
    act(() => {
      hook.value.onTouchStart(touchEvent(300))
      hook.value.onScrollBeginDrag(scrollEvent(500))
    })
    // Reader moved up ~20px, but a row above finished measuring and MVCP
    // raised the offset so raw y increased. Old code treated that as "not
    // upward" and animated scrollToEnd because distance was still < 44.
    act(() => {
      hook.value.onScroll(scrollEvent(520, 1040, 500))
      hook.value.onScrollEndDrag(scrollEvent(520, 1040, 500))
    })

    expect(hook.scrollToEnd).not.toHaveBeenCalled()
    act(() => {
      hook.value.onContentSizeChange()
    })
    expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
  })

  it('does not pin or snap while a finger is on the list', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onTouchStart(touchEvent(300))
      hook.value.onContentSizeChange()
      hook.value.scrollToBottomIfFollowing(false)
    })

    expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
    expect(hook.scrollToEnd).not.toHaveBeenCalled()

    act(() => {
      hook.value.onTouchEnd(touchEvent(300))
      hook.value.onContentSizeChange()
    })
    expect(hook.nativeScrollToEnd).toHaveBeenCalledWith({ animated: false })
  })

  it('keeps following off after an upward peek even when momentum later looks near the tail', () => {
    const hook = renderHook()

    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(500))
      hook.value.onScroll(scrollEvent(470))
      hook.value.onScrollEndDrag(scrollEvent(490, 1000, 500))
      hook.value.onMomentumScrollEnd(scrollEvent(490, 1000, 500))
    })

    expect(hook.scrollToEnd).not.toHaveBeenCalled()
    act(() => {
      hook.value.onContentSizeChange()
    })
    expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
  })
  it('remembers an upward touch through streaming layout and a small release reversal', () => {
    const hook = renderHook()
    act(() => {
      hook.value.onTouchStart(touchEvent(300))
      hook.value.onScrollBeginDrag(scrollEvent(500))
      hook.value.onContentSizeChange()
      // Row measurement moved the offset DOWN despite the finger reading UP.
      hook.value.onScroll(scrollEvent(520, 1040))
      // Native touch cancellation can carry the last finger position.
      hook.value.onTouchEnd(touchEvent(330))
      const release = scrollEvent(540, 1040)
      release.nativeEvent.velocity = { x: 0, y: 0.1 }
      hook.value.onScrollEndDrag(release)
      hook.value.onMomentumScrollEnd(scrollEvent(540, 1040))
      hook.value.onContentSizeChange()
      hook.value.scrollToBottomIfFollowing(false)
    })
    expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
  })

  it('latches touch movement before native drag recognition and cancellation', () => {
    const hook = renderHook()
    act(() => {
      hook.value.onTouchStart(touchEvent(300))
      hook.value.onTouchMove(touchEvent(320))
      hook.value.onTouchEnd(touchEvent(320))
      // A layout callback can arrive between touch cancellation and begin drag.
      hook.value.onContentSizeChange()
      hook.value.onScrollBeginDrag(scrollEvent(500))
      hook.value.onContentSizeChange()
      const release = scrollEvent(540, 1040)
      release.nativeEvent.velocity = { x: 0, y: 0.1 }
      hook.value.onScrollEndDrag(release)
      hook.value.onMomentumScrollEnd(scrollEvent(540, 1040))
      hook.value.onContentSizeChange()
    })
    expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
  })

  it('keeps an upward touch latched after the finger reverses past its starting point', () => {
    const hook = renderHook()
    act(() => {
      hook.value.onTouchStart(touchEvent(300))
      hook.value.onScrollBeginDrag(scrollEvent(500))
      hook.value.onContentSizeChange()
      hook.value.onTouchMove(touchEvent(330))
      hook.value.onTouchMove(touchEvent(290))
      hook.value.onTouchEnd(touchEvent(290))
      const release = scrollEvent(540, 1040)
      release.nativeEvent.velocity = { x: 0, y: 0.1 }
      hook.value.onScrollEndDrag(release)
      hook.value.onMomentumScrollEnd(scrollEvent(540, 1040))
      hook.value.onContentSizeChange()
    })
    expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()

    // A separate downward gesture can intentionally resume following.
    act(() => {
      hook.value.onTouchStart(touchEvent(400))
      hook.value.onScrollBeginDrag(scrollEvent(400, 1040))
      hook.value.onTouchMove(touchEvent(260))
      hook.value.onTouchEnd(touchEvent(260))
      hook.value.onScrollEndDrag(scrollEvent(540, 1040))
      hook.value.onContentSizeChange()
    })
    expect(hook.nativeScrollToEnd).toHaveBeenCalledTimes(1)
  })

  it('does not mistake shrinking content during a read-back for a return to the tail', () => {
    const hook = renderHook()
    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(460))
      // No intermediate onScroll: FlashList can suppress it during anchoring.
      // User moved UP 20px, but content shrank 60px: the gap falls 40 -> 0.
      hook.value.onScrollEndDrag(scrollEvent(440, 940))
      hook.value.onContentSizeChange()
      hook.value.scrollToBottomIfFollowing(false)
    })
    expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
  })

  it('does not infer a downward gesture from a viewport resize', () => {
    const hook = renderHook()
    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(400))
      hook.value.onScrollEndDrag(scrollEvent(380, 1000, 620))
      hook.value.onContentSizeChange()
    })
    expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
  })

  it('does not re-arm at release before an upward reversal decelerates', () => {
    const hook = renderHook()
    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(400))
      const release = scrollEvent(500)
      release.nativeEvent.velocity = { x: 0, y: -0.4 }
      hook.value.onScrollEndDrag(release)
      hook.value.onContentSizeChange()
      hook.value.onMomentumScrollEnd(scrollEvent(300))
      hook.value.scrollToBottomIfFollowing(false)
    })
    expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
  })

  it('leaves a small reading gap detached even after a downward drag', () => {
    const hook = renderHook()
    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(300))
      hook.value.onScrollEndDrag(scrollEvent(490))
      hook.value.onMomentumScrollEnd(scrollEvent(490))
      hook.value.onContentSizeChange()
    })
    expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
  })

  it('follows a deliberate downward fling through streaming only after it settles at the tail', () => {
    const hook = renderHook()
    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(300))
      const release = scrollEvent(600, 1100)
      release.nativeEvent.velocity = { x: 0, y: 0.5 }
      hook.value.onScrollEndDrag(release)
      hook.value.onContentSizeChange()
    })
    expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
    act(() => {
      hook.value.onMomentumScrollEnd(scrollEvent(700, 1200))
      hook.value.onContentSizeChange()
    })
    expect(hook.nativeScrollToEnd).toHaveBeenCalledTimes(1)
  })

  it('does not treat a layout change during momentum as a deliberate arrival', () => {
    const hook = renderHook()
    act(() => {
      hook.value.onScrollBeginDrag(scrollEvent(300))
      hook.value.onScrollEndDrag(scrollEvent(400))
      hook.value.onMomentumScrollEnd(scrollEvent(400, 900))
      hook.value.onContentSizeChange()
    })
    expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
  })

  it('never queues a delayed FlashList end scroll that can fire over a later drag', () => {
    vi.useFakeTimers()
    try {
      const hook = renderHook()
      hook.scrollToEnd.mockImplementation(() => {
        setTimeout(() => hook.nativeScrollToEnd({ animated: true }), 300)
      })
      act(() => {
        hook.value.scrollToBottom()
        hook.value.onScrollBeginDrag(scrollEvent(450))
      })
      hook.nativeScrollToEnd.mockClear()
      act(() => {
        vi.runAllTimers()
      })
      expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
      expect(hook.scrollToEnd).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
  it.each([
    { platform: 'ios', upward: -0.4, downward: 0.4 },
    { platform: 'android', upward: 0.4, downward: -0.4 },
  ] as const)(
    'uses $platform release velocity in the content direction',
    ({ platform, upward, downward }) => {
      const previous = Platform.OS
      Platform.OS = platform
      try {
        const hook = renderHook()
        act(() => {
          hook.value.onScrollBeginDrag(scrollEvent(400))
          const release = scrollEvent(500)
          release.nativeEvent.velocity = { x: 0, y: upward }
          hook.value.onScrollEndDrag(release)
          hook.value.onContentSizeChange()
          hook.value.onMomentumScrollEnd(scrollEvent(500))
          hook.value.onContentSizeChange()
        })
        expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
        act(() => {
          hook.value.onScrollBeginDrag(scrollEvent(300))
          const release = scrollEvent(600, 1100)
          release.nativeEvent.velocity = { x: 0, y: downward }
          hook.value.onScrollEndDrag(release)
          hook.value.onContentSizeChange()
        })
        expect(hook.nativeScrollToEnd).not.toHaveBeenCalled()
        act(() => {
          hook.value.onMomentumScrollEnd(scrollEvent(700, 1200))
          hook.value.onContentSizeChange()
        })
        expect(hook.nativeScrollToEnd).toHaveBeenCalledTimes(1)
      } finally {
        Platform.OS = previous
      }
    },
  )
})
