import { memo } from 'react'
import { Modal, Pressable, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Check } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'

import { Text } from './Text'

export type OptionSheetItem = {
  value: string
  label: string
  /** Secondary line under the label. */
  description?: string
  disabled?: boolean
  /** Shown in place of the description when the item is disabled. */
  disabledReason?: string
  destructive?: boolean
}

interface OptionSheetProps {
  title: string
  items: readonly OptionSheetItem[]
  /** Marks the current value with a check. Omit for action sheets. */
  selected?: string | null
  onSelect: (value: string) => void
  onClose: () => void
}

/** The app's one bottom sheet: option pickers and action menus both use it, so
    a chip in the composer and a queued-message menu feel like the same control. */
export const OptionSheet = memo(function OptionSheet({
  title,
  items,
  selected,
  onSelect,
  onClose,
}: OptionSheetProps) {
  const { theme } = useUnistyles()
  const insets = useSafeAreaInsets()

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close"
      />
      {/* The home indicator would otherwise sit on top of the last row. */}
      <View style={[styles.sheet, { paddingBottom: insets.bottom + theme.spacing[4] }]}>
        <View style={styles.handle} />
        <Text variant="label" color="primary" weight="semibold" style={styles.title}>
          {title}
        </Text>
        <ScrollView style={styles.list} bounces={false}>
          {items.map((item) => {
            const isSelected = selected !== undefined && item.value === selected
            const secondary = item.disabled ? item.disabledReason : item.description

            return (
              <Pressable
                key={item.value}
                style={[styles.item, isSelected ? styles.itemSelected : null]}
                disabled={item.disabled}
                accessibilityRole="button"
                // Without this VoiceOver reads the label and the description as
                // one run-on string; the description becomes the hint instead.
                accessibilityLabel={item.label}
                accessibilityHint={secondary}
                accessibilityState={{ disabled: Boolean(item.disabled), selected: isSelected }}
                onPress={() => {
                  void Haptics.selectionAsync()
                  onSelect(item.value)
                }}
              >
                <View style={styles.itemBody}>
                  <Text
                    size="sm"
                    color={item.disabled ? 'faint' : item.destructive ? 'danger' : 'primary'}
                  >
                    {item.label}
                  </Text>
                  {secondary ? (
                    <Text variant="caption" size="xs" color={item.disabled ? 'faint' : 'muted'}>
                      {secondary}
                    </Text>
                  ) : null}
                </View>
                {isSelected ? <Check size={theme.iconSize.sm} color={theme.colors.accent.default} /> : null}
              </Pressable>
            )
          })}
        </ScrollView>
      </View>
    </Modal>
  )
})

const styles = StyleSheet.create((theme) => ({
  backdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
  },
  sheet: {
    backgroundColor: theme.colors.surface[1],
    borderTopLeftRadius: theme.radius['2xl'],
    borderTopRightRadius: theme.radius['2xl'],
    borderCurve: 'continuous',
    paddingHorizontal: theme.spacing[4],
  },
  handle: {
    width: theme.spacing[8] + theme.spacing[1],
    height: theme.spacing[1],
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.border.emphasis,
    alignSelf: 'center',
    marginTop: theme.spacing[2],
    marginBottom: theme.spacing[3],
  },
  title: {
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  list: {
    // Long option lists (models) scroll instead of pushing the sheet off-screen.
    maxHeight: 360,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing[3],
    minHeight: theme.minTouchTarget,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.radius.lg,
  },
  itemSelected: {
    backgroundColor: theme.colors.surface[2],
  },
  itemBody: {
    flex: 1,
    gap: theme.spacing[0.5],
  },
}))
