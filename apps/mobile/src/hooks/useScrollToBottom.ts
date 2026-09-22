import { useCallback, useRef, useState } from 'react'
import type { FlashListRef } from '@shopify/flash-list'
import {
  Platform,
  type GestureResponderEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'

const SHOW_JUMP_OFFSET = 200
const RESUME_FOLLOW_OFFSET = 1
// Only tolerate subpixel rounding at the tail. A small reading gap is still
// detached, even if streaming would close it with just one pin.
const UPWARD_PEEK = 1

type ScrollMetrics = { y: number; height: number; viewport: number }
type Drag = {
  start: ScrollMetrics
  layoutChanged: boolean
  readBack: boolean
  releasedTowardBottom: boolean
  releaseVelocity: number
}

function metrics(
  event: NativeSyntheticEvent<NativeScrollEvent>,
): ScrollMetrics {
  const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
  return {
    y: contentOffset.y,
    height: contentSize.height,
    viewport: layoutMeasurement.height,
  }
}

// FlashList's own bottom-pinning, permanently off: a negative threshold makes
// its bound detection skip the near-bottom bookkeeping entirely.
const AUTOSCROLL_DISABLED = -1

function distanceFromBottom(event: NativeSyntheticEvent<NativeScrollEvent>) {
  const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
  return contentSize.height - layoutMeasurement.height - contentOffset.y
}

/**
 * Owns tail following independently of FlashList's sticky autoscroll flag.
 * A drag detaches immediately; only a deliberate return to the actual tail
 * (after momentum), an explicit jump/send, or thread reset can attach again.
 *
 * Distance to the bottom is position, NOT gesture direction: content can
 * shrink and the viewport can grow while the reader scrolls up. FlashList
 * also drops onScroll during offset correction, so we cannot rely on seeing
 * every intermediate movement. Latch upward finger movement independently of
 * layout; use release velocity and stable offsets to recognize a return.
 */
export function useScrollToBottom<T>() {
  const listRef = useRef<FlashListRef<T>>(null)
  const [showJumpButton, setShowJumpButton] = useState(false)
  const showJumpButtonRef = useRef(false)
  const isFollowingRef = useRef(true)
  const fingerDownRef = useRef(false)
  const dragRef = useRef<Drag | null>(null)
  const touchRef = useRef<{
    id: GestureResponderEvent['nativeEvent']['identifier']
    y: number
    readBack: boolean
  } | null>(null)

  const setFollowing = useCallback((next: boolean) => {
    isFollowingRef.current = next
  }, [])

  const pinToBottom = useCallback((animated: boolean) => {
    // FlashList.scrollToEnd queues a timer (and potentially a multi-step
    // scrollToIndex). A later drag cannot cancel that work. The native command
    // is immediate and the next drag can stop its animation.
    listRef.current?.getNativeScrollRef()?.scrollToEnd({ animated })
  }, [])

  const onTouchStart = useCallback((event: GestureResponderEvent) => {
    if (!fingerDownRef.current) {
      touchRef.current = {
        id: event.nativeEvent.identifier,
        y: event.nativeEvent.pageY,
        readBack: false,
      }
    }
    fingerDownRef.current = true
  }, [])

  const onTouchMove = useCallback((event: GestureResponderEvent) => {
    const touch = touchRef.current
    if (!touch || touch.id !== event.nativeEvent.identifier) return
    // Screen coordinates preserve intent when streaming/anchoring changes
    // content offsets. Once a finger pulls down to read older content, a tiny
    // reversal at release must not re-arm following for this gesture.
    if (event.nativeEvent.pageY > touch.y + UPWARD_PEEK) {
      touch.readBack = true
      setFollowing(false)
      if (dragRef.current) dragRef.current.readBack = true
    }
  }, [setFollowing])

  const onTouchEnd = useCallback((event: GestureResponderEvent) => {
    // iOS can cancel React touches when the native scroll gesture takes over.
    // Its final coordinates still carry intent; retain it for begin/end drag.
    onTouchMove(event)
    fingerDownRef.current = false
  }, [onTouchMove])

  const observeDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const drag = dragRef.current
      if (!drag) return null
      const current = metrics(event)
      if (
        current.height !== drag.start.height ||
        current.viewport !== drag.start.viewport
      ) {
        drag.layoutChanged = true
      }
      if (!drag.layoutChanged && current.y < drag.start.y - UPWARD_PEEK) {
        drag.readBack = true
      }
      return drag
    },
    [],
  )

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      observeDrag(event)
      const nextVisible = distanceFromBottom(event) > SHOW_JUMP_OFFSET
      if (nextVisible === showJumpButtonRef.current) return
      showJumpButtonRef.current = nextVisible
      setShowJumpButton(nextVisible)
    },
    [observeDrag],
  )

  const onScrollBeginDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      dragRef.current = {
        start: metrics(event),
        layoutChanged: false,
        readBack: touchRef.current?.readBack ?? false,
        releasedTowardBottom: false,
        releaseVelocity: 0,
      }
      setFollowing(false)
      // Native dragging already interrupts a scroll animation. Replaying the
      // begin event's offset here rewinds a gesture that progressed while JS
      // was busy rendering streamed content.
    },
    [setFollowing],
  )

  const resumeFollowing = useCallback(() => {
    dragRef.current = null
    touchRef.current = null
    setFollowing(true)
  }, [setFollowing])

  const onScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const drag = observeDrag(event)
      fingerDownRef.current = false
      if (!drag) return
      // iOS reports content velocity; Android's VelocityHelper reports finger
      // velocity. Normalize so positive always means toward newer messages.
      const nativeVelocity = event.nativeEvent.velocity?.y ?? 0
      const velocity =
        Platform.OS === 'android' ? -nativeVelocity : nativeVelocity
      drag.releaseVelocity = velocity
      if (velocity < 0) drag.readBack = true
      drag.releasedTowardBottom =
        !drag.readBack &&
        (velocity > 0 ||
          (!drag.layoutChanged &&
            event.nativeEvent.contentOffset.y > drag.start.y + UPWARD_PEEK))
      // A nonzero release velocity still has momentum ahead of it. Never pin
      // between release and momentum end, even if release is at the tail.
      if (
        velocity === 0 &&
        drag.releasedTowardBottom &&
        distanceFromBottom(event) <= RESUME_FOLLOW_OFFSET
      ) {
        resumeFollowing()
      }
    },
    [observeDrag, resumeFollowing],
  )

  const onMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const drag = observeDrag(event)
      if (fingerDownRef.current) return
      dragRef.current = null
      if (
        drag?.releasedTowardBottom &&
        !drag.readBack &&
        (!drag.layoutChanged || drag.releaseVelocity > 0) &&
        distanceFromBottom(event) <= RESUME_FOLLOW_OFFSET
      ) {
        resumeFollowing()
      }
    },
    [observeDrag, resumeFollowing],
  )

  /**
   * The pin itself. Content grows from streamed output, from rows that finish
   * measuring, and from the composer resizing the viewport — every one of those
   * lands here, and none of them move the list unless the reader is following
   * and does not have a finger on the list.
   */
  const onContentSizeChange = useCallback(() => {
    // Even if size returns to its original value before the next scroll event,
    // geometry changed during this gesture and offset-only intent is unsafe.
    if (dragRef.current) dragRef.current.layoutChanged = true
    if (!isFollowingRef.current || fingerDownRef.current) return
    pinToBottom(false)
  }, [pinToBottom])

  const scrollToBottom = useCallback(
    (animated = true) => {
      showJumpButtonRef.current = false
      setShowJumpButton(false)
      dragRef.current = null
      touchRef.current = null
      setFollowing(true)
      pinToBottom(animated)
    },
    [pinToBottom, setFollowing],
  )

  /**
   * For callers that want the tail in view after data lands — opening a thread,
   * a reconnect refresh — without stealing the position of a reader who has
   * scrolled back through the transcript, or one whose finger is already on
   * the list.
   */
  const scrollToBottomIfFollowing = useCallback(
    (animated = true) => {
      if (!isFollowingRef.current || fingerDownRef.current) return
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
    fingerDownRef.current = false
    dragRef.current = null
    touchRef.current = null
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
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    resetScrollState,
    scrollToBottom,
    scrollToBottomIfFollowing,
    scrollToBottomIfNear,
  }
}
