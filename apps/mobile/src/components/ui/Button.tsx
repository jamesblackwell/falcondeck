import { memo, useCallback, useEffect } from 'react'
import { Pressable, type PressableProps } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import * as Haptics from 'expo-haptics'

import { ActivityDiamond } from './ActivityDiamond'
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
  const { theme } = useUnistyles()
  const scale = useSharedValue(1)
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    if (reducedMotion) {
      cancelAnimation(scale)
      scale.value = 1
    }
    return () => cancelAnimation(scale)
  }, [reducedMotion, scale])

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }))

  /* v8 ignore start — Reanimated worklets + Pressable callbacks, tested via E2E */
  const handlePressIn = useCallback(() => {
    'worklet'
    scale.value = reducedMotion ? 1 : withTiming(0.97, { duration: 100 })
  }, [reducedMotion, scale])

  const handlePressOut = useCallback(() => {
    'worklet'
    scale.value = reducedMotion ? 1 : withTiming(1, { duration: 100 })
  }, [reducedMotion, scale])

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
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled || loading), busy: Boolean(loading) }}
      hitSlop={size === 'icon' ? (theme.minTouchTarget - 40) / 2 : undefined}
      disabled={disabled || loading}
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      {...props}
    >
      {loading ? (
        <ActivityDiamond
          size={theme.iconSize.md}
          color={isInverted ? theme.colors.surface[0] : theme.colors.fg.primary}
        />
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
  size_default: {
    minHeight: theme.minTouchTarget,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  size_sm: {
    minHeight: theme.minTouchTarget,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.radius.md,
  },
  size_lg: {
    minHeight: 52,
    paddingHorizontal: theme.spacing[5],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.radius.xl,
  },
  size_icon: { height: theme.minTouchTarget, width: theme.minTouchTarget, borderRadius: theme.radius.md },
  disabled: { opacity: 0.4 },
  invertedText: { color: theme.colors.surface[0] },
}))
