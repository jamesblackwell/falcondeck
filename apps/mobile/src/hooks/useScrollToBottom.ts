import { useCallback, useRef, useState } from 'react'
import type { FlashListRef } from '@shopify/flash-list'
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native'

const SHOW_JUMP_OFFSET = 200

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

  const onContentSizeChange = useCallback(() => {
    if (showJumpButtonRef.current) return
    listRef.current?.scrollToEnd({ animated: false })
  }, [])

  return { listRef, showJumpButton, onContentSizeChange, onScroll, resetScrollState, scrollToBottom }
}
