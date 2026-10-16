import { memo, useCallback, useEffect } from 'react'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated'
import { ArrowDown } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'

import { GlassButton, SymbolIcon } from '@/components/ui'

const FAB_SIZE = 40

interface JumpToBottomFabProps {
  visible: boolean
  onPress: () => void
}

/** A glass circle that floats above the composer once the reader has
    scrolled away from the newest message. The parent positions it. */
export const JumpToBottomFab = memo(function JumpToBottomFab({
  visible,
  onPress,
}: JumpToBottomFabProps) {
  const { theme } = useUnistyles()
  const opacity = useSharedValue(0)
  const translateY = useSharedValue(12)
  const scale = useSharedValue(0.9)

  useEffect(() => {
    const config = { duration: 200, easing: Easing.out(Easing.cubic) }
    opacity.value = withTiming(visible ? 1 : 0, config)
    translateY.value = withTiming(visible ? 0 : 12, config)
    scale.value = withTiming(visible ? 1 : 0.9, config)
  }, [visible, opacity, translateY, scale])

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }, { scale: scale.value }],
  }))

  const handlePress = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    onPress()
  }, [onPress])

  return (
    <Animated.View style={[styles.wrapper, animatedStyle]} pointerEvents={visible ? 'auto' : 'none'}>
      <GlassButton
        size={FAB_SIZE}
        onPress={handlePress}
        accessibilityLabel="Jump to latest message"
        hitSlop={(theme.minTouchTarget - FAB_SIZE) / 2}
      >
        <SymbolIcon
          name="arrow.down"
          fallback={ArrowDown}
          size={17}
          weight="semibold"
          color={theme.colors.fg.primary}
        />
      </GlassButton>
    </Animated.View>
  )
})

const styles = StyleSheet.create(() => ({
  wrapper: {
    alignSelf: 'center',
  },
}))
