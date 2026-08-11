import { memo } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'
import * as Haptics from 'expo-haptics'

import { Text } from './Text'

export interface SegmentOption {
  value: string
  label: string
}

interface SegmentedControlProps {
  label: string
  options: readonly SegmentOption[]
  selectedValue: string
  onChange: (value: string) => void
}

export const SegmentedControl = memo(function SegmentedControl({
  label,
  options,
  selectedValue,
  onChange,
}: SegmentedControlProps) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Text variant="label" color="muted">
        {label}
      </Text>
      <View style={styles.row}>
        {options.map((option) => {
          const selected = selectedValue === option.value
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityLabel={`${label}: ${option.label}`}
              accessibilityState={{ selected }}
              onPress={() => {
                void Haptics.selectionAsync()
                onChange(option.value)
              }}
              style={({ pressed }) => [
                styles.segment,
                selected && styles.segmentSelected,
                pressed && styles.segmentPressed,
              ]}
            >
              <Text variant="label" color={selected ? 'accent' : 'secondary'}>
                {option.label}
              </Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    backgroundColor: theme.colors.surface[2],
  },
  segmentSelected: {
    borderColor: theme.colors.accent.default,
    backgroundColor: theme.colors.accent.muted,
  },
  segmentPressed: {
    opacity: 0.72,
  },
}))
