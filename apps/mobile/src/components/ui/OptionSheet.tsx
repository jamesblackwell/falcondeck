import { memo, useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, TextInput, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Check } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'

import {
  filterOptionsByQuery,
  SEARCHABLE_OPTION_THRESHOLD,
} from '@falcondeck/client-core'

import { NativeSheet } from './NativeSheet'
import { PaletteSwatch, type PaletteSwatchColors } from './PaletteSwatch'
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
  /** Colour chip shown before the label — used by the theme picker. */
  swatch?: PaletteSwatchColors
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
  const [query, setQuery] = useState('')
  const searchable = items.length >= SEARCHABLE_OPTION_THRESHOLD
  const visibleItems = useMemo(
    () =>
      searchable
        ? filterOptionsByQuery(
            items,
            query,
            (item) => `${item.label} ${item.description ?? ''} ${item.value}`,
          )
        : items,
    [items, query, searchable],
  )

  useEffect(() => setQuery(''), [title])

  return (
    <NativeSheet onClose={onClose} accessibilityLabel="Close options" contentStyle={styles.content}>
      <Text variant="label" color="primary" weight="semibold" style={styles.title}>
        {title}
      </Text>
      {searchable ? (
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search…"
          placeholderTextColor={theme.colors.fg.muted}
          selectionColor={theme.colors.accent.default}
          accessibilityLabel={`Search ${title.toLocaleLowerCase()}`}
          accessibilityHint={`${visibleItems.length} ${visibleItems.length === 1 ? 'option' : 'options'}`}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="done"
          style={styles.searchInput}
        />
      ) : null}
      <ScrollView
        style={styles.list}
        bounces={false}
        keyboardShouldPersistTaps="handled"
      >
        {visibleItems.map((item) => {
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
              {item.swatch ? <PaletteSwatch colors={item.swatch} /> : null}
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
        {visibleItems.length === 0 ? (
          <Text
            variant="caption"
            color="muted"
            accessibilityLiveRegion="polite"
            style={styles.empty}
          >
            No options match “{query.trim()}”
          </Text>
        ) : null}
      </ScrollView>
    </NativeSheet>
  )
})

const styles = StyleSheet.create((theme) => ({
  content: {
    paddingHorizontal: theme.spacing[4],
  },
  title: {
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  list: {
    // Long option lists (models) scroll instead of pushing the sheet off-screen.
    maxHeight: 360,
  },
  searchInput: {
    minHeight: theme.minTouchTarget,
    marginHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface[2],
    paddingHorizontal: theme.spacing[3],
    color: theme.colors.fg.primary,
    fontSize: theme.fontSize.sm,
  },
  empty: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[5],
    textAlign: 'center',
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
