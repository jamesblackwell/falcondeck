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
import { withAlpha } from '@/theme/color'

const FAB_SIZE = 40
/** Effectively gone, without the singular matrix a zero scale produces. */
const HIDDEN_SCALE = 0.01

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
  // Scale, never opacity: UIKit's glass stops rendering once an ancestor's
  // alpha has been animated, leaving a bare arrow over the transcript.
  const scale = useSharedValue(visible ? 1 : HIDDEN_SCALE)
  const translateY = useSharedValue(visible ? 0 : 10)

  useEffect(() => {
    const config = { duration: 220, easing: Easing.out(Easing.cubic) }
    scale.value = withTiming(visible ? 1 : HIDDEN_SCALE, config)
    translateY.value = withTiming(visible ? 0 : 10, config)
  }, [visible, scale, translateY])

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }, { scale: scale.value }],
  }))

  const handlePress = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    onPress()
  }, [onPress])

  return (
    <Animated.View
      style={[styles.wrapper, animatedStyle]}
      pointerEvents={visible ? 'auto' : 'none'}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
    >
      <GlassButton
        size={FAB_SIZE}
        // It always sits over transcript text, where clear glass leaves the
        // arrow floating among the words; a palette tint gives it a body.
        tint={withAlpha(theme.colors.surface[2], theme.isDark ? 0.72 : 0.8)}
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
