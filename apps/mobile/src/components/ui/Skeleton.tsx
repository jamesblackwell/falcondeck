import { memo, useEffect } from 'react'
import { type ViewProps } from 'react-native'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

interface SkeletonProps extends ViewProps {
  width?: number | string
  height?: number
  radius?: number
}

export const Skeleton = memo(function Skeleton({
  width = '100%',
  height = 16,
  radius,
  style,
  ...props
}: SkeletonProps) {
  const { theme } = useUnistyles()
  const opacity = useSharedValue(0.4)

  useEffect(() => {
    opacity.value = withRepeat(withTiming(1, { duration: 1000 }), -1, true)
  }, [opacity])

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }))

  return (
    <Animated.View
      style={[
        styles.base,
        { width: width as number, height, borderRadius: radius ?? theme.radius.md },
        animatedStyle,
        style,
      ]}
      {...props}
    />
  )
})

const styles = StyleSheet.create((theme) => ({
  base: {
    backgroundColor: theme.colors.surface[3],
    borderCurve: 'continuous',
  },
}))
