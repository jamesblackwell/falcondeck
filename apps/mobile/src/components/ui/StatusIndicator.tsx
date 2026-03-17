import { memo, useEffect } from 'react'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import { StyleSheet } from 'react-native-unistyles'

type Status = 'connected' | 'connecting' | 'disconnected' | 'error' | 'idle' | 'active'

interface StatusIndicatorProps {
  status: Status
  size?: 'sm' | 'md'
  pulse?: boolean
}

export const StatusIndicator = memo(function StatusIndicator({
  status,
  size = 'sm',
  pulse,
}: StatusIndicatorProps) {
  const opacity = useSharedValue(1)

  useEffect(() => {
    if (pulse) {
      opacity.value = withRepeat(withTiming(0.3, { duration: 800 }), -1, true)
    } else {
      opacity.value = withTiming(1, { duration: 150 })
    }
  }, [pulse, opacity])

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }))

  return (
    <Animated.View
      style={[
        styles.base,
        size === 'sm' ? styles.sm : styles.md,
        styles[status],
        animatedStyle,
      ]}
    />
  )
})

const styles = StyleSheet.create((theme) => ({
  base: { borderRadius: theme.radius.full },
  sm: { width: 6, height: 6 },
  md: { width: 10, height: 10 },
  connected: { backgroundColor: theme.colors.success.default },
  connecting: { backgroundColor: theme.colors.warning.default },
  disconnected: { backgroundColor: theme.colors.danger.default },
  error: { backgroundColor: theme.colors.danger.default },
  idle: { backgroundColor: theme.colors.fg.muted },
  active: { backgroundColor: theme.colors.accent.default },
}))
