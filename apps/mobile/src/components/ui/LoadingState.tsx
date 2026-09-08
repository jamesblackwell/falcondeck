import { memo } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import { ActivityDiamond } from './ActivityDiamond'
import { Text } from './Text'

interface LoadingStateProps {
  /** Muted caption under the diamond. Omit when a banner already names the wait. */
  label?: string
  accessibilityLabel?: string
  /** Fill the parent (conversation pane, full screen) instead of hugging content. */
  fill?: boolean
  style?: StyleProp<ViewStyle>
}

/** Centered wait for a pane that has nothing else to show yet. */
export const LoadingState = memo(function LoadingState({
  label,
  accessibilityLabel,
  fill = false,
  style,
}: LoadingStateProps) {
  const { theme } = useUnistyles()

  const announced = accessibilityLabel ?? label

  return (
    <View
      style={[styles.container, fill ? styles.fill : undefined, style]}
      accessibilityRole={announced ? 'progressbar' : undefined}
      accessibilityLiveRegion={announced ? 'polite' : undefined}
      accessibilityLabel={announced}
    >
      <ActivityDiamond
        size={fill ? theme.iconSize.md : theme.iconSize.sm}
        color={theme.colors.accent.default}
      />
      {label ? (
        <Text variant="caption" color="muted">
          {label}
        </Text>
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[8],
    paddingHorizontal: theme.spacing[6],
  },
  fill: {
    flex: 1,
  },
}))
