import { memo } from 'react'
import { View, type ViewProps } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

type CardVariant = 'elevated' | 'flat' | 'ghost'

interface CardProps extends ViewProps {
  variant?: CardVariant
}

export const Card = memo(function Card({
  variant = 'flat',
  style,
  children,
  ...props
}: CardProps) {
  return (
    <View style={[styles.base, styles[variant], style]} {...props}>
      {children}
    </View>
  )
})

export const CardHeader = memo(function CardHeader({ style, children, ...props }: ViewProps) {
  return <View style={[styles.header, style]} {...props}>{children}</View>
})

export const CardContent = memo(function CardContent({ style, children, ...props }: ViewProps) {
  return <View style={[styles.content, style]} {...props}>{children}</View>
})

const styles = StyleSheet.create((theme) => ({
  base: {
    borderRadius: theme.radius.xl,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  elevated: {
    backgroundColor: theme.colors.surface[2],
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    ...theme.shadow.md,
  },
  flat: {
    backgroundColor: theme.colors.surface[1],
    borderWidth: 1,
    borderColor: theme.colors.border.default,
  },
  ghost: { backgroundColor: theme.colors.transparent },
  header: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.subtle,
  },
  content: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
}))
