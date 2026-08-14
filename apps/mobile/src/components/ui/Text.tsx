import { memo } from 'react'
import { Text as RNText, type TextProps as RNTextProps } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

type TextVariant =
  | 'body'
  | 'supporting'
  | 'label'
  | 'meta'
  | 'microlabel'
  | 'heading'
  | 'mono'
  | 'caption'
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
  color,
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
        color ? styles[`color_${color}`] : undefined,
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
  supporting: {
    color: theme.colors.fg.secondary,
    fontFamily: theme.fontFamily.sans,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * theme.lineHeight.normal,
  },
  label: {
    fontFamily: theme.fontFamily.sans,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * theme.lineHeight.normal,
    fontWeight: '500',
  },
  caption: {
    fontFamily: theme.fontFamily.sans,
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * theme.lineHeight.normal,
    color: theme.colors.fg.tertiary,
  },
  meta: {
    color: theme.colors.fg.muted,
    fontFamily: theme.fontFamily.sans,
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * theme.lineHeight.normal,
  },
  microlabel: {
    color: theme.colors.fg.muted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize['2xs'],
    fontWeight: '500',
    letterSpacing: 1.2,
    lineHeight: theme.fontSize['2xs'] * theme.lineHeight.tight,
    textTransform: 'uppercase',
  },
  heading: {
    fontFamily: theme.fontFamily.sans,
    fontSize: theme.fontSize.xl,
    lineHeight: theme.fontSize.xl * theme.lineHeight.tight,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  mono: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * theme.lineHeight.normal,
  },
  size_2xs: {
    fontSize: theme.fontSize['2xs'],
    lineHeight: theme.fontSize['2xs'] * theme.lineHeight.normal,
  },
  size_xs: {
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * theme.lineHeight.normal,
  },
  size_sm: {
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * theme.lineHeight.normal,
  },
  size_base: {
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * theme.lineHeight.normal,
  },
  size_md: {
    fontSize: theme.fontSize.md,
    lineHeight: theme.fontSize.md * theme.lineHeight.normal,
  },
  size_lg: {
    fontSize: theme.fontSize.lg,
    lineHeight: theme.fontSize.lg * theme.lineHeight.normal,
  },
  size_xl: {
    fontSize: theme.fontSize.xl,
    lineHeight: theme.fontSize.xl * theme.lineHeight.normal,
  },
  'size_2xl': {
    fontSize: theme.fontSize['2xl'],
    lineHeight: theme.fontSize['2xl'] * theme.lineHeight.normal,
  },
  'size_3xl': {
    fontSize: theme.fontSize['3xl'],
    lineHeight: theme.fontSize['3xl'] * theme.lineHeight.normal,
  },
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
