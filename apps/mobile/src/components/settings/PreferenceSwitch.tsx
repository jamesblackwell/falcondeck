import { memo } from 'react'
import { Switch, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import { Text } from '@/components/ui'

export const PreferenceSwitch = memo(function PreferenceSwitch({
  label,
  description,
  value,
  disabled,
  onValueChange,
}: {
  label: string
  description?: string
  value: boolean
  disabled?: boolean
  onValueChange: (value: boolean) => void
}) {
  const { theme } = useUnistyles()
  return (
    // Dim the whole row while it is off-limits: a disabled iOS switch alone is
    // a subtle cue, and these rows go dead as a group when push is turned off.
    <View style={[styles.row, disabled ? styles.disabled : undefined]}>
      <View style={styles.copy}>
        <Text variant="label" color="primary">{label}</Text>
        {description ? (
          <Text variant="caption" color="muted" style={styles.description}>{description}</Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityRole="switch"
        accessibilityLabel={label}
        accessibilityHint={description}
        trackColor={{ false: theme.colors.surface[3], true: theme.colors.accent.default }}
        // iOS draws the off-track from this rather than trackColor.false.
        ios_backgroundColor={theme.colors.surface[3]}
        thumbColor={theme.colors.white}
      />
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: theme.minTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  disabled: { opacity: 0.45 },
  copy: { flex: 1 },
  description: { marginTop: theme.spacing[1] },
}))
