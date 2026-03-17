import { memo, useCallback } from 'react'
import { Pressable, type PressableProps, ActivityIndicator } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated'
import * as Haptics from 'expo-haptics'

import { Text } from './Text'

type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'danger'
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon'

interface ButtonProps extends Omit<PressableProps, 'style'> {
  variant?: ButtonVariant
  size?: ButtonSize
  label?: string
  icon?: React.ReactNode
  loading?: boolean
  children?: React.ReactNode
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

export const Button = memo(function Button({
  variant = 'default',
  size = 'default',
  label,
  icon,
  loading,
  disabled,
  onPress,
  children,
  ...props
}: ButtonProps) {
  const scale = useSharedValue(1)

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }))

  /* v8 ignore start — Reanimated worklets + Pressable callbacks, tested via E2E */
  const handlePressIn = useCallback(() => {
    'worklet'
    scale.value = withTiming(0.97, { duration: 100 })
  }, [scale])

  const handlePressOut = useCallback(() => {
    'worklet'
    scale.value = withTiming(1, { duration: 100 })
  }, [scale])

  const handlePress = useCallback(
    (e: Parameters<NonNullable<PressableProps['onPress']>>[0]) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      onPress?.(e)
    },
    [onPress],
  )
  /* v8 ignore stop */

  const isInverted = variant === 'default' || variant === 'danger'

  return (
    <AnimatedPressable
      style={[
        styles.base,
        styles[`variant_${variant}`],
        styles[`size_${size}`],
        (disabled || loading) ? styles.disabled : undefined,
        animatedStyle,
      ]}
      disabled={disabled || loading}
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      {...props}
    >
      {loading ? (
        <ActivityIndicator size="small" color={isInverted ? '#09090b' : '#f4f4f6'} />
      ) : (
        <>
          {icon}
          {label ? (
            <Text variant="label" style={isInverted ? styles.invertedText : undefined}>
              {label}
            </Text>
          ) : null}
          {children}
        </>
      )}
    </AnimatedPressable>
  )
})

const styles = StyleSheet.create((theme) => ({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.lg,
    borderCurve: 'continuous',
    gap: theme.spacing[2],
  },
  variant_default: { backgroundColor: theme.colors.accent.default },
  variant_secondary: { backgroundColor: theme.colors.surface[3] },
  variant_outline: {
    backgroundColor: theme.colors.transparent,
    borderWidth: 1,
    borderColor: theme.colors.border.emphasis,
  },
  variant_ghost: { backgroundColor: theme.colors.transparent },
  variant_danger: { backgroundColor: theme.colors.danger.default },
  size_default: { height: 44, paddingHorizontal: theme.spacing[4] },
  size_sm: { height: 36, paddingHorizontal: theme.spacing[3], borderRadius: theme.radius.md },
  size_lg: { height: 52, paddingHorizontal: theme.spacing[5], borderRadius: theme.radius.xl },
  size_icon: { height: 40, width: 40, borderRadius: theme.radius.md },
  disabled: { opacity: 0.4 },
  invertedText: { color: theme.colors.surface[0] },
}))
