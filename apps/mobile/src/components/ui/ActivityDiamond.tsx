import { memo, useEffect, useMemo } from 'react'
import { Animated, Easing } from 'react-native'
import { useReducedMotion } from 'react-native-reanimated'
import { StyleSheet } from 'react-native-unistyles'

interface ActivityDiamondProps {
  size?: number
  color: string
  /** `outline` marks work in flight without the agent generating — a
   *  backgrounded command the thread is waiting on. Same shape, less ink. */
  variant?: 'solid' | 'outline'
}

const CYCLE_DURATION_MS = 2400
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
 * diamond. The native Animated driver updates transform/opacity directly;
 * Reanimated's worklet driver committed the Fabric view tree every frame,
 * even while the conversation was idle. Share the clock and interpolation
 * nodes so recycled rows join the existing animation without restarting it.
 */
const clock = new Animated.Value(0)
const animatedStyle = {
  opacity: clock.interpolate({ inputRange: KEYFRAMES, outputRange: OPACITY }),
  transform: [
    { rotate: clock.interpolate({ inputRange: KEYFRAMES, outputRange: ROTATION.map(value => `${45 + value}deg`) }) },
    { scale: clock.interpolate({ inputRange: KEYFRAMES, outputRange: SCALE }) },
  ],
}
const staticStyle = { opacity: 1, transform: [{ rotate: '45deg' }, { scale: 1 }] }
let clockSubscribers = 0
let animation: Animated.CompositeAnimation | null = null

function acquireClock() {
  clockSubscribers += 1
  if (clockSubscribers > 1) return
  clock.setValue(0)
  animation = Animated.loop(Animated.timing(clock, {
    toValue: 1,
    duration: CYCLE_DURATION_MS,
    easing: Easing.linear,
    useNativeDriver: true,
    isInteraction: false,
  }))
  animation.start()
}

function releaseClock() {
  clockSubscribers = Math.max(0, clockSubscribers - 1)
  if (clockSubscribers === 0) {
    animation?.stop()
    animation = null
  }
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

  return <Animated.View accessible={false} style={[styles.base, diamondStyle, reducedMotion ? staticStyle : animatedStyle]} />
})

const styles = StyleSheet.create({
  base: {
    borderRadius: 1,
  },
})
