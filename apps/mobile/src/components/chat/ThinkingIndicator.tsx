import { memo } from 'react'
import { View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import { Spinner, Text } from '@/components/ui'

/** Liveness row for a running turn with nothing else on screen to say so.
    It shares the work-session header's geometry and spinner: the two swap
    in the same slot under the transcript, and matching metrics keep that
    handoff from moving a pixel. */
export const ThinkingIndicator = memo(function ThinkingIndicator() {
  const { theme } = useUnistyles()

  return (
    <View style={styles.row}>
      <Spinner size={theme.iconSize.xs} color={theme.colors.accent.default} />
      <Text variant="label" color="muted">
        Thinking…
      </Text>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[1],
    // Same height as the (touch-target-sized) work-session row, so the
    // transcript's bottom edge doesn't hop when one replaces the other.
    minHeight: theme.minTouchTarget,
  },
}))
