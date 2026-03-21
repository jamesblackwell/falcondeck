import { memo, useEffect } from 'react'
import { View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  withDelay,
} from 'react-native-reanimated'

export const ThinkingIndicator = memo(function ThinkingIndicator() {
  const dot1 = useSharedValue(0.3)
  const dot2 = useSharedValue(0.3)
  const dot3 = useSharedValue(0.3)

  useEffect(() => {
    const duration = 400
    const pulse = (delay: number) =>
      withDelay(
        delay,
        withRepeat(
          withSequence(withTiming(1, { duration }), withTiming(0.3, { duration })),
          -1,
        ),
      )
    dot1.value = pulse(0)
    dot2.value = pulse(150)
    dot3.value = pulse(300)
  }, [dot1, dot2, dot3])

  const style1 = useAnimatedStyle(() => ({ opacity: dot1.value }))
  const style2 = useAnimatedStyle(() => ({ opacity: dot2.value }))
  const style3 = useAnimatedStyle(() => ({ opacity: dot3.value }))

  return (
    <View style={styles.container}>
      <View style={styles.dotRow}>
        <Animated.View style={[styles.dot, style1]} />
        <Animated.View style={[styles.dot, style2]} />
        <Animated.View style={[styles.dot, style3]} />
      </View>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  dotRow: {
    flexDirection: 'row',
    gap: theme.spacing[1],
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.fg.muted,
  },
}))
