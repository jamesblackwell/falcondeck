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
    <View style={styles.row}>
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
        trackColor={{ false: theme.colors.surface[3], true: theme.colors.accent.default }}
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
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.subtle,
  },
  copy: { flex: 1 },
  description: { marginTop: theme.spacing[1] },
}))
