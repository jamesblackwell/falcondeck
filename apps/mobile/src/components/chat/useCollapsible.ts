import { useCallback, useEffect, useState } from 'react'
import type { LayoutChangeEvent } from 'react-native'
import { Easing, useAnimatedStyle, useDerivedValue, useSharedValue, withTiming } from 'react-native-reanimated'

const COLLAPSIBLE_TIMING = {
  duration: 250,
  easing: Easing.out(Easing.cubic),
} as const

export function useCollapsible(defaultOpen: boolean) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const contentHeight = useSharedValue(0)
  const progress = useSharedValue(defaultOpen ? 1 : 0)
  const rotation = useDerivedValue(() => `${progress.value * 90}deg`)

  useEffect(() => {
    setIsOpen(defaultOpen)
    progress.value = withTiming(defaultOpen ? 1 : 0, COLLAPSIBLE_TIMING)
  }, [defaultOpen, progress])

  const toggle = useCallback(() => {
    setIsOpen((current) => {
      const next = !current
      progress.value = withTiming(next ? 1 : 0, COLLAPSIBLE_TIMING)
      return next
    })
  }, [progress])

  const onContentLayout = useCallback(
    (event: LayoutChangeEvent) => {
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
