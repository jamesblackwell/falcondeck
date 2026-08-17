import { memo } from 'react'
import { Pressable, View } from 'react-native'
import { Check } from 'lucide-react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import { Text } from '@/components/ui'

export const ChoiceRow = memo(function ChoiceRow({
  label,
  description,
  selected,
  disabled,
  onPress,
}: {
  label: string
  description?: string
  selected: boolean
  disabled?: boolean
  onPress: () => void
}) {
  const { theme } = useUnistyles()
  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        pressed ? styles.pressed : undefined,
        disabled ? styles.disabled : undefined,
      ]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled }}
      accessibilityLabel={label}
    >
      <View style={styles.copy}>
        <Text variant="label" color={selected ? 'accent' : 'primary'}>{label}</Text>
        {description ? (
          <Text variant="caption" color="muted" style={styles.description}>{description}</Text>
        ) : null}
      </View>
      {selected ? <Check size={theme.iconSize.sm} color={theme.colors.accent.default} /> : null}
    </Pressable>
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
  pressed: { backgroundColor: theme.colors.surface[2] },
  disabled: { opacity: 0.45 },
  copy: { flex: 1 },
  description: { marginTop: theme.spacing[1] },
}))
