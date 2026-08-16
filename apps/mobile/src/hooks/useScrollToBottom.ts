import { useCallback, useRef, useState } from 'react'
import type { FlashListRef } from '@shopify/flash-list'
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native'

const SHOW_JUMP_OFFSET = 200
const RESUME_FOLLOW_OFFSET = 44
// FlashList's own bottom-pinning, permanently off: a negative threshold makes
// its bound detection skip the near-bottom bookkeeping entirely.
const AUTOSCROLL_DISABLED = -1

function distanceFromBottom(event: NativeSyntheticEvent<NativeScrollEvent>) {
  const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
  return contentSize.height - layoutMeasurement.height - contentOffset.y
}

/**
 * Jump-to-bottom affordance + stream-following state for the transcript list.
 *
 * Following is owned here rather than by FlashList's
 * `maintainVisibleContentPosition.autoscrollToBottomThreshold`. That threshold
 * sets a *sticky* near-bottom flag which only clears when FlashList processes a
 * scroll event — and it ignores scroll events for 100ms after every content
 * position correction, which is exactly what streaming into a re-measuring
 * transcript produces. A flag armed at the bottom therefore survives the drag
 * that should have cleared it, and each new chunk fires `scrollToEnd` over the
 * reader: scroll up a screen or two, get dragged back down.
 *
 * So the pin is explicit: this hook follows the tail until a drag starts, and
 * re-arms only when the user deliberately returns to the bottom — ends a drag
 * or momentum there — or taps the jump button. While following, `onContentSizeChange`
 * pins the viewport as content grows; while not following, nothing scrolls at all.
 */
export function useScrollToBottom<T>() {
  const listRef = useRef<FlashListRef<T>>(null)
  const [showJumpButton, setShowJumpButton] = useState(false)
  const showJumpButtonRef = useRef(false)
  const isFollowingRef = useRef(true)
  const dragStartOffsetRef = useRef<number | null>(null)

  const setFollowing = useCallback((next: boolean) => {
    isFollowingRef.current = next
  }, [])

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const nextVisible = distanceFromBottom(event) > SHOW_JUMP_OFFSET
    if (nextVisible === showJumpButtonRef.current) return

    showJumpButtonRef.current = nextVisible
    setShowJumpButton(nextVisible)
  }, [])

  const onScrollBeginDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      dragStartOffsetRef.current = event.nativeEvent.contentOffset.y
      setFollowing(false)
    },
    [setFollowing],
  )

  const resumeFollowing = useCallback(() => {
    setFollowing(true)
    listRef.current?.scrollToEnd({ animated: true })
  }, [setFollowing])

  const onScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const dragStart = dragStartOffsetRef.current
      dragStartOffsetRef.current = null
      // Only resume when the drag ended near the bottom AND wasn't a net
      // upward pull — resuming on an upward fling's release would scrollToEnd
      // right over the gesture this hook exists to protect.
      if (dragStart !== null && event.nativeEvent.contentOffset.y < dragStart) {
        return
      }
      if (distanceFromBottom(event) <= RESUME_FOLLOW_OFFSET) {
        resumeFollowing()
      }
    },
    [resumeFollowing],
  )

  const onMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (
        !isFollowingRef.current &&
        distanceFromBottom(event) <= RESUME_FOLLOW_OFFSET
      ) {
        resumeFollowing()
      }
    },
    [resumeFollowing],
  )

  /**
   * The pin itself. Content grows from streamed output, from rows that finish
   * measuring, and from the composer resizing the viewport — every one of those
   * lands here, and none of them move the list unless the reader is following.
   */
  const onContentSizeChange = useCallback(() => {
    if (!isFollowingRef.current) return
    listRef.current?.scrollToEnd({ animated: true })
  }, [])

  const scrollToBottom = useCallback(
    (animated = true) => {
      showJumpButtonRef.current = false
      setShowJumpButton(false)
      setFollowing(true)
      listRef.current?.scrollToEnd({ animated })
    },
    [setFollowing],
  )

  /**
   * For callers that want the tail in view after data lands — opening a thread,
   * a reconnect refresh — without stealing the position of a reader who has
   * scrolled back through the transcript.
   */
  const scrollToBottomIfFollowing = useCallback(
    (animated = true) => {
      if (!isFollowingRef.current) return
      scrollToBottom(animated)
    },
    [scrollToBottom],
  )

  const resetScrollState = useCallback(() => {
    showJumpButtonRef.current = false
    setShowJumpButton(false)
    setFollowing(true)
  }, [setFollowing])

  return {
    listRef,
    showJumpButton,
    autoscrollToBottomThreshold: AUTOSCROLL_DISABLED,
    onContentSizeChange,
    onScroll,
    onScrollBeginDrag,
    onScrollEndDrag,
    onMomentumScrollEnd,
    resetScrollState,
    scrollToBottom,
    scrollToBottomIfFollowing,
  }
}
