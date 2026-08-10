import { useCallback, useRef, useState } from 'react'
import type { FlashListRef } from '@shopify/flash-list'
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native'

const SHOW_JUMP_OFFSET = 200
const RESUME_FOLLOW_OFFSET = 44
const FOLLOW_THRESHOLD = 0.2

function distanceFromBottom(event: NativeSyntheticEvent<NativeScrollEvent>) {
  const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
  return contentSize.height - layoutMeasurement.height - contentOffset.y
}

/**
 * Jump-to-bottom affordance + stream-following state for the transcript list.
 *
 * FlashList v2's `maintainVisibleContentPosition.autoscrollToBottomThreshold`
 * owns pinning to the bottom while content streams in, but its "near bottom"
 * flag is sticky: every streamed chunk fires an animated `scrollToEnd` while
 * the flag is set, which cancels an in-progress upward drag before the user
 * can escape the threshold — making the transcript unscrollable during fast
 * streaming. So following is an explicit state here: the moment a drag starts
 * the threshold drops to 0 (the flag clears on the first drag frame and the
 * pin disengages), and it re-arms only when the user deliberately returns to
 * the bottom — ends a drag or momentum there — or taps the jump button.
 */
export function useScrollToBottom<T>() {
  const listRef = useRef<FlashListRef<T>>(null)
  const [showJumpButton, setShowJumpButton] = useState(false)
  const showJumpButtonRef = useRef(false)
  const [isFollowing, setIsFollowing] = useState(true)
  const isFollowingRef = useRef(true)
  const dragStartOffsetRef = useRef<number | null>(null)

  const setFollowing = useCallback((next: boolean) => {
    if (isFollowingRef.current === next) return
    isFollowingRef.current = next
    setIsFollowing(next)
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
    // Land exactly on the bottom: the final scroll event re-arms FlashList's
    // internal near-bottom flag so the native pin takes over again.
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

  const scrollToBottom = useCallback(
    (animated = true) => {
      showJumpButtonRef.current = false
      setShowJumpButton(false)
      setFollowing(true)
      listRef.current?.scrollToEnd({ animated })
    },
    [setFollowing],
  )

  const resetScrollState = useCallback(() => {
    showJumpButtonRef.current = false
    setShowJumpButton(false)
    setFollowing(true)
  }, [setFollowing])

  return {
    listRef,
    showJumpButton,
    // While following, FlashList pins the viewport to the bottom as chunks
    // stream in. While not following, a threshold of 0 (instead of disabling
    // with a negative value) keeps FlashList's checkBounds running so its
    // sticky near-bottom flag is cleared on the first drag frame — a disabled
    // threshold would leave the stale flag armed for one more yank.
    autoscrollToBottomThreshold: isFollowing ? FOLLOW_THRESHOLD : 0,
    onScroll,
    onScrollBeginDrag,
    onScrollEndDrag,
    onMomentumScrollEnd,
    resetScrollState,
    scrollToBottom,
  }
}
