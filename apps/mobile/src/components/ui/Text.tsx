import { memo } from 'react'
import { Text as RNText, type TextProps as RNTextProps } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

type TextVariant = 'body' | 'label' | 'caption' | 'heading' | 'mono'
type TextColor = 'primary' | 'secondary' | 'tertiary' | 'muted' | 'faint' | 'accent' | 'danger' | 'warning' | 'success' | 'info'

interface TextProps extends RNTextProps {
  variant?: TextVariant
  size?: '2xs' | 'xs' | 'sm' | 'base' | 'md' | 'lg' | 'xl' | '2xl' | '3xl'
  color?: TextColor
  weight?: 'normal' | 'medium' | 'semibold' | 'bold'
}

export const Text = memo(function Text({
  variant = 'body',
  size,
  color = 'primary',
  weight,
  style,
  ...props
}: TextProps) {
  return (
    <RNText
      style={[
        styles.base,
        styles[variant],
        size ? styles[`size_${size}`] : undefined,
        styles[`color_${color}`],
        weight ? styles[`weight_${weight}`] : undefined,
        style,
      ]}
      {...props}
    />
  )
})

const styles = StyleSheet.create((theme) => ({
  base: {
    color: theme.colors.fg.primary,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * theme.lineHeight.normal,
  },
  body: {
    fontFamily: theme.fontFamily.sans,
  },
  label: {
    fontFamily: theme.fontFamily.sans,
    fontSize: theme.fontSize.sm,
    fontWeight: '500',
  },
  caption: {
    fontFamily: theme.fontFamily.sans,
    fontSize: theme.fontSize.xs,
    color: theme.colors.fg.tertiary,
  },
  heading: {
    fontFamily: theme.fontFamily.sans,
    fontSize: theme.fontSize.xl,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  mono: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  size_2xs: { fontSize: theme.fontSize['2xs'] },
  size_xs: { fontSize: theme.fontSize.xs },
  size_sm: { fontSize: theme.fontSize.sm },
  size_base: { fontSize: theme.fontSize.base },
  size_md: { fontSize: theme.fontSize.md },
  size_lg: { fontSize: theme.fontSize.lg },
  size_xl: { fontSize: theme.fontSize.xl },
  'size_2xl': { fontSize: theme.fontSize['2xl'] },
  'size_3xl': { fontSize: theme.fontSize['3xl'] },
  color_primary: { color: theme.colors.fg.primary },
  color_secondary: { color: theme.colors.fg.secondary },
  color_tertiary: { color: theme.colors.fg.tertiary },
  color_muted: { color: theme.colors.fg.muted },
  color_faint: { color: theme.colors.fg.faint },
  color_accent: { color: theme.colors.accent.default },
  color_danger: { color: theme.colors.danger.default },
  color_warning: { color: theme.colors.warning.default },
  color_success: { color: theme.colors.success.default },
  color_info: { color: theme.colors.info.default },
  weight_normal: { fontWeight: '400' },
  weight_medium: { fontWeight: '500' },
  weight_semibold: { fontWeight: '600' },
  weight_bold: { fontWeight: '700' },
}))
