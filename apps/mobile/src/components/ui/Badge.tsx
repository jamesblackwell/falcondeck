import { memo } from 'react'
import { View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

import { Text } from './Text'

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info'

interface BadgeProps {
  variant?: BadgeVariant
  dot?: boolean
  children: string
}

export const Badge = memo(function Badge({
  variant = 'default',
  dot,
  children,
}: BadgeProps) {
  return (
    <View style={[styles.base, styles[`bg_${variant}`]]}>
      {dot ? <View style={[styles.dot, styles[`dot_${variant}`]]} /> : null}
      <Text variant="caption" size="2xs" style={styles[`text_${variant}`]}>
        {children}
      </Text>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.radius.full,
    borderCurve: 'continuous',
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  bg_default: { backgroundColor: theme.colors.surface[3] },
  bg_success: { backgroundColor: theme.colors.success.muted },
  bg_warning: { backgroundColor: theme.colors.warning.muted },
  bg_danger: { backgroundColor: theme.colors.danger.muted },
  bg_info: { backgroundColor: theme.colors.info.muted },
  dot_default: { backgroundColor: theme.colors.fg.muted },
  dot_success: { backgroundColor: theme.colors.success.default },
  dot_warning: { backgroundColor: theme.colors.warning.default },
  dot_danger: { backgroundColor: theme.colors.danger.default },
  dot_info: { backgroundColor: theme.colors.info.default },
  text_default: { color: theme.colors.fg.secondary },
  text_success: { color: theme.colors.success.default },
  text_warning: { color: theme.colors.warning.default },
  text_danger: { color: theme.colors.danger.default },
  text_info: { color: theme.colors.info.default },
}))
