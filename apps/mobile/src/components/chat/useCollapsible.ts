import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { LayoutChangeEvent } from 'react-native'
import { Easing, useAnimatedStyle, useDerivedValue, useSharedValue, withTiming } from 'react-native-reanimated'

const COLLAPSIBLE_TIMING = {
  duration: 250,
  easing: Easing.out(Easing.cubic),
} as const

/**
 * Collapse/expand state for a transcript block.
 *
 * `resetKey` must identify the block being rendered (its item id). FlashList
 * recycles component instances across items, so without it this hook keeps the
 * previous block's open state and — worse — its measured content height, which
 * renders the next block clipped to the wrong size and animates it while the
 * user scrolls. That is exactly what "messages randomly disappear and flicker"
 * looks like. When `resetKey` changes the state snaps to the new block's
 * default with no animation; animation is reserved for the same block's
 * default flipping (a tool finishing auto-collapses) and user toggles.
 */
export function useCollapsible(defaultOpen: boolean, resetKey?: string) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const contentHeight = useSharedValue(0)
  const progress = useSharedValue(defaultOpen ? 1 : 0)
  const rotation = useDerivedValue(() => `${progress.value * 90}deg`)
  const appliedResetKeyRef = useRef(resetKey)

  useLayoutEffect(() => {
    const isRecycledInstance = appliedResetKeyRef.current !== resetKey
    appliedResetKeyRef.current = resetKey
    setIsOpen(defaultOpen)
    if (isRecycledInstance) {
      // The stale height belongs to whatever block this instance rendered
      // before; zero means "use the content's natural height until the new
      // layout is measured".
      contentHeight.value = 0
      progress.value = defaultOpen ? 1 : 0
      return
    }
    progress.value = withTiming(defaultOpen ? 1 : 0, COLLAPSIBLE_TIMING)
  }, [contentHeight, defaultOpen, progress, resetKey])

  const toggle = useCallback(() => {
    setIsOpen((current) => {
      const next = !current
      progress.value = withTiming(next ? 1 : 0, COLLAPSIBLE_TIMING)
      return next
    })
  }, [progress])

  const onContentLayout = useCallback(
    (event: LayoutChangeEvent) => {
      // Writing `.value` is how Reanimated shared values are updated; the rule
      // reads it as mutating a hook argument.
      // eslint-disable-next-line react-hooks/immutability
      contentHeight.value = event.nativeEvent.layout.height
    },
    [contentHeight],
  )

  const bodyStyle = useAnimatedStyle(() => ({
    height:
      contentHeight.value > 0
        ? progress.value * contentHeight.value
        : progress.value === 0
          ? 0
          : undefined,
    opacity: progress.value,
    overflow: 'hidden' as const,
  }))

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: rotation.value }],
  }))

  return {
    isOpen,
    toggle,
    onContentLayout,
    bodyStyle,
    chevronStyle,
  }
}
