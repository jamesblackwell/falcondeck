import { memo, useEffect, useMemo } from 'react'
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
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

const CYCLE_DURATION_MS = 2400
const STATIC_PROGRESS = 0.47
const KEYFRAMES = [0, 0.1, 0.19, 0.29, 0.38, 0.47, 0.5, 0.74, 0.77, 0.86, 1]
const OPACITY = [0.55, 1, 0.55, 1, 0.55, 1, 1, 1, 1, 0.55, 0.55]
const SCALE = [0.82, 1, 0.82, 1, 0.82, 1, 1, 1, 1, 0.82, 0.82]
const ROTATION = [0, 0, 0, 0, 0, 0, 12, 348, 360, 360, 360]

/** A small double-pulse-and-turn diamond for live agent work. */
export const ActivityDiamond = memo(function ActivityDiamond({
  size = 14,
  color,
}: ActivityDiamondProps) {
  const reducedMotion = useReducedMotion()
  const progress = useSharedValue(reducedMotion ? STATIC_PROGRESS : 0)

  useEffect(() => {
    cancelAnimation(progress)
    progress.set(
      reducedMotion
        ? STATIC_PROGRESS
        : withRepeat(
            withTiming(1, { duration: CYCLE_DURATION_MS, easing: Easing.linear }),
            -1,
          ),
    )
    return () => cancelAnimation(progress)
  }, [progress, reducedMotion])

  const animatedStyle = useAnimatedStyle(() => {
    const value = progress.get()
    return {
      opacity: interpolate(value, KEYFRAMES, OPACITY),
      transform: [
        { rotate: `${45 + interpolate(value, KEYFRAMES, ROTATION)}deg` },
        { scale: interpolate(value, KEYFRAMES, SCALE) },
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
