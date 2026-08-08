import { memo, useEffect } from 'react'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import { Loader2 } from 'lucide-react-native'

interface SpinnerProps {
  size?: number
  color: string
}

/**
 * A spinner that actually spins. Lucide icons are static SVGs, so rendering
 * `Loader`/`Loader2` bare just draws a frozen arc — the rotation has to be
 * driven here. The shared value lives across parent re-renders, so streaming
 * updates don't restart or stutter the animation.
 */
export const Spinner = memo(function Spinner({ size = 14, color }: SpinnerProps) {
  const rotation = useSharedValue(0)

  useEffect(() => {
    rotation.value = withRepeat(
      withTiming(360, { duration: 900, easing: Easing.linear }),
      -1,
    )
    return () => {
      cancelAnimation(rotation)
    }
  }, [rotation])

  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }))

  return (
    <Animated.View style={style}>
      <Loader2 size={size} color={color} />
    </Animated.View>
  )
})
