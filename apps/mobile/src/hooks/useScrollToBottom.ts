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
 * re-arms only when the user deliberately returns to the bottom — ends a
 * downward drag or downward fling there, or taps the jump button. An upward
 * drag does not re-arm on release or on momentum, even if it settles a few
 * pixels from the tail; that small gap is how you start reading back, and
 * snapping it shut feels like the list is fighting you.
 *
 * While following, content-size changes pin instantly through the native
 * scroller. FlashList.scrollToEnd is animated and defers its native call with
 * setTimeout(0), so a late markdown/actions/mermaid layout after the turn
 * finishes can start a glide that keeps running after the reader has already
 * grabbed the list. Instant native pinning cannot wrestle a drag, and a drag
 * start cancels any jump-button glide still in flight.
 */
export function useScrollToBottom<T>() {
  const listRef = useRef<FlashListRef<T>>(null)
  const [showJumpButton, setShowJumpButton] = useState(false)
  const showJumpButtonRef = useRef(false)
  const isFollowingRef = useRef(true)
  const dragStartOffsetRef = useRef<number | null>(null)
  const suppressFollowResumeRef = useRef(false)

  const setFollowing = useCallback((next: boolean) => {
    isFollowingRef.current = next
  }, [])

  const pinToBottomInstant = useCallback(() => {
    const list = listRef.current
    if (!list) return
    const native = list.getNativeScrollRef?.()
    if (native && typeof native.scrollToEnd === 'function') {
      native.scrollToEnd({ animated: false })
      return
    }
    list.scrollToEnd({ animated: false })
  }, [])

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const nextVisible = distanceFromBottom(event) > SHOW_JUMP_OFFSET
    if (nextVisible === showJumpButtonRef.current) return

    showJumpButtonRef.current = nextVisible
    setShowJumpButton(nextVisible)
  }, [])

  const onScrollBeginDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = event.nativeEvent.contentOffset.y
      dragStartOffsetRef.current = offset
      suppressFollowResumeRef.current = false
      setFollowing(false)
      // Kill an in-flight jump-button (or leftover) glide so the finger owns
      // the position from the first frame of the drag.
      listRef.current?.scrollToOffset({ offset, animated: false })
    },
    [setFollowing],
  )

  const resumeFollowing = useCallback(() => {
    suppressFollowResumeRef.current = false
    setFollowing(true)
    listRef.current?.scrollToEnd({ animated: true })
  }, [setFollowing])

  const onScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const dragStart = dragStartOffsetRef.current
      dragStartOffsetRef.current = null
      // Only resume when the drag ended near the bottom AND wasn't a net
      // upward pull — resuming on an upward fling's release would scrollToEnd
      // right over the gesture this hook exists to protect. Momentum must
      // honour the same veto: it fires after endDrag and used to snap a
      // 20–40px read-back shut because it still looked "near the tail".
      if (dragStart !== null && event.nativeEvent.contentOffset.y < dragStart) {
        suppressFollowResumeRef.current = true
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
      if (suppressFollowResumeRef.current) return
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
    pinToBottomInstant()
  }, [pinToBottomInstant])

  const scrollToBottom = useCallback(
    (animated = true) => {
      showJumpButtonRef.current = false
      setShowJumpButton(false)
      suppressFollowResumeRef.current = false
      setFollowing(true)
      if (animated) {
        listRef.current?.scrollToEnd({ animated: true })
        return
      }
      pinToBottomInstant()
    },
    [pinToBottomInstant, setFollowing],
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

  /**
   * For the send path. A reader hovering just above the tail wants to watch
   * their message land, so sending snaps down and re-arms following — but a
   * reader deep in the transcript keeps their place. "Near" is the jump-button
   * threshold, so the FAB being visible and a send leaving the list alone are
   * the same state.
   */
  const scrollToBottomIfNear = useCallback(() => {
    if (showJumpButtonRef.current) return
    scrollToBottom()
  }, [scrollToBottom])

  const resetScrollState = useCallback(() => {
    showJumpButtonRef.current = false
    setShowJumpButton(false)
    suppressFollowResumeRef.current = false
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
    scrollToBottomIfNear,
  }
}
