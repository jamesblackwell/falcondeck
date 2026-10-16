import { memo } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { AlertTriangle, X } from 'lucide-react-native'

import { layeredFill } from '@/theme/color'

import { Text } from './Text'

interface ErrorBannerProps {
  message: string | null
  onDismiss: () => void
  /** Renders as a rounded card that floats over content under a glass header. */
  floating?: boolean
}

/** The last failed action, in view until it is dismissed or the next action
    succeeds. Without it a failed send or approval is silent. */
export const ErrorBanner = memo(function ErrorBanner({
  message,
  onDismiss,
  floating = false,
}: ErrorBannerProps) {
  const { theme } = useUnistyles()

  if (!message) return null

  return (
    <View
      style={[
        styles.container,
        floating
          ? [styles.floating, layeredFill(theme.colors.surface[1], theme.colors.danger.muted)]
          : null,
      ]}
      accessibilityLiveRegion="polite"
    >
      <AlertTriangle size={theme.iconSize.xs} color={theme.colors.danger.default} />
      <Text variant="caption" size="xs" color="danger" style={styles.message}>
        {message}
      </Text>
      <Pressable
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss error"
        hitSlop={(theme.minTouchTarget - theme.iconSize.sm) / 2}
      >
        <X size={theme.iconSize.sm} color={theme.colors.danger.default} />
      </Pressable>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.danger.muted,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.subtle,
  },
  message: {
    flex: 1,
  },
  floating: {
    marginHorizontal: theme.spacing[3],
    borderRadius: theme.radius.xl,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.emphasis,
    ...theme.shadow.sm,
    shadowOpacity: theme.isDark ? 0.3 : 0.06,
  },
}))
