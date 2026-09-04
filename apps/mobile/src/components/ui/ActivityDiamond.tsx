import { memo, useEffect, useMemo } from 'react'
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  makeMutable,
  useAnimatedStyle,
  useReducedMotion,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import { StyleSheet } from 'react-native-unistyles'

interface ActivityDiamondProps {
  size?: number
  color: string
  /** `outline` marks work in flight without the agent generating — a
   *  backgrounded command the thread is waiting on. Same shape, less ink. */
  variant?: 'solid' | 'outline'
}

const CYCLE_DURATION_MS = 2400
const STATIC_PROGRESS = 0.47
const KEYFRAMES = [0, 0.1, 0.19, 0.29, 0.38, 0.47, 0.5, 0.74, 0.77, 0.86, 1]
const OPACITY = [0.55, 1, 0.55, 1, 0.55, 1, 1, 1, 1, 0.55, 0.55]
const SCALE = [0.82, 1, 0.82, 1, 0.82, 1, 1, 1, 1, 0.82, 0.82]
const ROTATION = [0, 0, 0, 0, 0, 0, 12, 348, 360, 360, 360]

/**
 * One clock for every diamond on screen.
 *
 * These mark live agent work, so during a busy turn they appear in the sidebar
 * for each running thread and again on every in-flight block in the transcript
 * — and FlashList recycling mounts and unmounts them constantly. Giving each
 * instance its own repeating timing meant a separate animation driver per
 * diamond plus a JS-to-UI-thread animation start on every remount. A single
 * module-level driver, reference counted so it runs only while something is
 * actually using it, costs the same whether one diamond is visible or thirty,
 * and a remounting row simply reads the clock that is already running (which
 * also keeps the diamonds in phase with each other).
 */
const clock = makeMutable(0)
let clockSubscribers = 0

function acquireClock() {
  clockSubscribers += 1
  if (clockSubscribers > 1) return
  clock.value = 0
  clock.value = withRepeat(
    withTiming(1, { duration: CYCLE_DURATION_MS, easing: Easing.linear }),
    -1,
  )
}

function releaseClock() {
  clockSubscribers = Math.max(0, clockSubscribers - 1)
  if (clockSubscribers === 0) cancelAnimation(clock)
}

/** A small double-pulse-and-turn diamond for live agent work. */
export const ActivityDiamond = memo(function ActivityDiamond({
  size = 14,
  color,
  variant = 'solid',
}: ActivityDiamondProps) {
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    if (reducedMotion) return
    acquireClock()
    return releaseClock
  }, [reducedMotion])

  const animatedStyle = useAnimatedStyle(() => {
    const value = reducedMotion ? STATIC_PROGRESS : clock.get()
    return {
      opacity: interpolate(value, KEYFRAMES, OPACITY),
      transform: [
        { rotate: `${45 + interpolate(value, KEYFRAMES, ROTATION)}deg` },
        { scale: interpolate(value, KEYFRAMES, SCALE) },
      ],
    }
  }, [reducedMotion])
  const diamondStyle = useMemo(
    () => ({
      width: size * 0.58,
      height: size * 0.58,
      ...(variant === 'outline'
        ? { borderWidth: 1, borderColor: color }
        : { backgroundColor: color }),
    }),
    [color, size, variant],
  )

  return <Animated.View accessible={false} style={[styles.base, diamondStyle, animatedStyle]} />
})

const styles = StyleSheet.create({
  base: {
    borderRadius: 1,
  },
})
