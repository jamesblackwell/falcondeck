import { useCallback, useRef, useState } from 'react'
import type { FlashListRef } from '@shopify/flash-list'
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native'

const SHOW_JUMP_OFFSET = 200

/**
 * Jump-to-bottom affordance for the transcript list.
 *
 * Keeping the view pinned to the bottom while content streams in is NOT done
 * here: FlashList v2's `maintainVisibleContentPosition.autoscrollToBottomThreshold`
 * owns that natively. The previous manual `scrollToEnd` on every content size
 * change raced the scroll handler while cells re-measured during recycling,
 * teleporting the list mid-scroll — which read as messages randomly
 * disappearing and flickering.
 */
export function useScrollToBottom<T>() {
  const listRef = useRef<FlashListRef<T>>(null)
  const [showJumpButton, setShowJumpButton] = useState(false)
  const showJumpButtonRef = useRef(false)

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y
    const nextVisible = distanceFromBottom > SHOW_JUMP_OFFSET
    if (nextVisible === showJumpButtonRef.current) return

    showJumpButtonRef.current = nextVisible
    setShowJumpButton(nextVisible)
  }, [])

  const scrollToBottom = useCallback((animated = true) => {
    showJumpButtonRef.current = false
    setShowJumpButton(false)
    listRef.current?.scrollToEnd({ animated })
  }, [])

  const resetScrollState = useCallback(() => {
    showJumpButtonRef.current = false
    setShowJumpButton(false)
  }, [])

  return {
    listRef,
    showJumpButton,
    onScroll,
    resetScrollState,
    scrollToBottom,
  }
}
