import { memo, type ReactNode } from 'react'
import {
  Pressable,
  View,
  type AccessibilityState,
  type Insets,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import { useGlassMode } from '@/lib/glass'

import { GlassSurface } from './GlassSurface'

/** UIKit's bar-button size: a 44pt glass circle. */
export const GLASS_CONTROL_SIZE = 44

interface GlassButtonProps {
  children: ReactNode
  onPress?: () => void
  onLongPress?: () => void
  accessibilityLabel: string
  accessibilityHint?: string
  accessibilityState?: AccessibilityState
  disabled?: boolean
  /** Painted height; circles are as wide as they are tall. */
  size?: number
  /** `pill` grows to fit a label, as "Done" and "New" do. */
  shape?: 'circle' | 'pill'
  /**
   * UIKit's prominent glass: the material tinted with a colour, for the one
   * primary action in a cluster. Pass the colour the label sits on.
   */
  tint?: string
  hitSlop?: number | Insets
  style?: StyleProp<ViewStyle>
  testID?: string
}

/**
 * A floating glass control. On Liquid Glass the press response is UIKit's
 * own (the material swells and brightens under the finger); the fallbacks
 * dim and settle instead, since a static blur has no response of its own.
 */
export const GlassButton = memo(function GlassButton({
  children,
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  disabled = false,
  size = GLASS_CONTROL_SIZE,
  shape = 'circle',
  tint,
  hitSlop,
  style,
  testID,
}: GlassButtonProps) {
  const mode = useGlassMode()
  const isLiquid = mode === 'liquid'
  const radius = size / 2

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, ...accessibilityState }}
      style={({ pressed }) => [
        shape === 'circle' ? { width: size, height: size } : { height: size },
        // Liquid Glass answers the press itself; the fallbacks dim and settle.
        !isLiquid && pressed ? styles.pressedFallback : null,
        style,
      ]}
    >
      <GlassSurface
        radius={radius}
        tint={tint}
        interactive={!disabled}
        intensity={70}
        highlight={false}
        fill
        style={styles.fill}
        contentStyle={[styles.content, shape === 'pill' ? styles.pill : null]}
      >
        <View pointerEvents="none" style={[styles.inner, disabled ? styles.disabled : null]}>
          {children}
        </View>
      </GlassSurface>
    </Pressable>
  )
})

interface GlassButtonGroupProps {
  children: ReactNode
  style?: StyleProp<ViewStyle>
  size?: number
}

/**
 * Several bar actions sharing one glass capsule, the way UIKit groups
 * neighbouring bar button items. Each child is a {@link GlassGroupItem}.
 */
export const GlassButtonGroup = memo(function GlassButtonGroup({
  children,
  style,
  size = GLASS_CONTROL_SIZE,
}: GlassButtonGroupProps) {
  return (
    <GlassSurface
      radius={size / 2}
      intensity={70}
      highlight={false}
      fill
      style={[styles.group, { height: size }, style]}
      contentStyle={styles.groupContent}
    >
      {children}
    </GlassSurface>
  )
})

interface GlassGroupItemProps {
  children: ReactNode
  onPress?: () => void
  accessibilityLabel: string
  accessibilityHint?: string
  accessibilityState?: AccessibilityState
  disabled?: boolean
  width?: number
  testID?: string
}

/** One action inside a {@link GlassButtonGroup}. */
export const GlassGroupItem = memo(function GlassGroupItem({
  children,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  disabled = false,
  width = 40,
  testID,
}: GlassGroupItemProps) {
  const { theme } = useUnistyles()
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, ...accessibilityState }}
      hitSlop={{ top: 4, bottom: 4 }}
      style={({ pressed }) => [
        styles.item,
        { width: width - 4 },
        pressed ? { backgroundColor: theme.isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.07)' } : null,
        disabled ? styles.disabled : null,
      ]}
    >
      {children}
    </Pressable>
  )
})

const styles = StyleSheet.create((theme) => ({
  fill: {
    flex: 1,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pill: {
    paddingHorizontal: theme.spacing[4],
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing[2],
  },
  pressedFallback: {
    opacity: 0.72,
    transform: [{ scale: 0.96 }],
  },
  disabled: {
    opacity: 0.4,
  },
  group: {
    alignSelf: 'flex-start',
  },
  groupContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 2,
  },
  // The painted press circle; hitSlop extends the target to the full row.
  item: {
    height: 36,
    marginHorizontal: 2,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
}))
