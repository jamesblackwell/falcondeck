import { memo, useEffect, useMemo } from 'react'
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import { StyleSheet } from 'react-native-unistyles'

interface ActivityDiamondProps {
  size?: number
  color: string
}

/** A small pulsing diamond for live agent work. */
export const ActivityDiamond = memo(function ActivityDiamond({
  size = 14,
  color,
}: ActivityDiamondProps) {
  const pulse = useSharedValue(0)
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    cancelAnimation(pulse)
    pulse.set(
      reducedMotion
        ? 1
        : withRepeat(withTiming(1, { duration: 800 }), -1, true),
    )
    return () => cancelAnimation(pulse)
  }, [pulse, reducedMotion])

  const animatedStyle = useAnimatedStyle(() => {
    const value = pulse.get()
    return {
      opacity: 0.55 + value * 0.45,
      transform: [
        { rotate: '45deg' },
        { scale: 0.82 + value * 0.18 },
      ],
    }
  })
  const diamondStyle = useMemo(
    () => ({ width: size * 0.58, height: size * 0.58, backgroundColor: color }),
    [color, size],
  )

  return <Animated.View accessible={false} style={[styles.base, diamondStyle, animatedStyle]} />
})

const styles = StyleSheet.create({
  base: {
    borderRadius: 1,
  },
})
