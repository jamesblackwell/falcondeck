import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { SymbolIcon } from './SymbolIcon'
import { Text } from './Text'

/** Leaves a row of context above the revealed selection. */
const SELECTED_REVEAL_INSET = 64

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

  // A long list (the transcription models, the model picker) opens at the top,
  // which hides the option you are actually on. Scroll it into view once, off
  // the row's own layout so rows with and without a description both land right.
  const listRef = useRef<ScrollView>(null)
  const selectedOffset = useRef<number | null>(null)
  const hasRevealed = useRef(false)
  const revealSelected = useCallback(() => {
    if (hasRevealed.current || selectedOffset.current === null) return
    hasRevealed.current = true
    listRef.current?.scrollTo({
      y: Math.max(0, selectedOffset.current - SELECTED_REVEAL_INSET),
      animated: false,
    })
  }, [])

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
        ref={listRef}
        style={styles.list}
        bounces={false}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={revealSelected}
      >
        <View style={visibleItems.length > 0 ? styles.group : null}>
        {visibleItems.map((item, index) => {
          const isSelected = selected !== undefined && item.value === selected
          const secondary = item.disabled ? item.disabledReason : item.description

          return (
            <Pressable
              key={item.value}
              style={({ pressed }) => [
                styles.item,
                index > 0 ? styles.itemDivided : null,
                pressed && !item.disabled ? styles.itemPressed : null,
              ]}
              onLayout={
                isSelected
                  ? (event) => {
                      selectedOffset.current = event.nativeEvent.layout.y
                      // A frame later the scroll view knows its content size,
                      // so the scroll is not clamped back to the top.
                      requestAnimationFrame(revealSelected)
                    }
                  : undefined
              }
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
                  size="base"
                  color={item.disabled ? 'faint' : item.destructive ? 'danger' : 'primary'}
                >
                  {item.label}
                </Text>
                {secondary ? (
                  <Text variant="supporting" color={item.disabled ? 'faint' : 'muted'}>
                    {secondary}
                  </Text>
                ) : null}
              </View>
              {isSelected ? (
                <SymbolIcon
                  name="checkmark"
                  fallback={Check}
                  size={15}
                  weight="semibold"
                  color={theme.colors.accent.default}
                />
              ) : null}
            </Pressable>
          )
        })}
        </View>
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
    paddingBottom: theme.spacing[3],
  },
  list: {
    // Long option lists (models) scroll instead of pushing the sheet off-screen.
    maxHeight: 360,
  },
  searchInput: {
    minHeight: 40,
    marginBottom: theme.spacing[2],
    borderRadius: theme.radius.full,
    borderCurve: 'continuous',
    backgroundColor: theme.isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(9, 9, 11, 0.06)',
    paddingHorizontal: theme.spacing[4],
    color: theme.colors.fg.primary,
    fontSize: theme.fontSize.sm,
  },
  // Inset grouped, as iOS lists options inside a sheet.
  group: {
    borderRadius: 20,
    borderCurve: 'continuous',
    overflow: 'hidden',
    backgroundColor: theme.isDark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(255, 255, 255, 0.78)',
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
    minHeight: 50,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
  },
  itemDivided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(9, 9, 11, 0.09)',
  },
  itemPressed: {
    backgroundColor: theme.isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(9, 9, 11, 0.05)',
  },
  itemBody: {
    flex: 1,
    gap: theme.spacing[0.5],
  },
}))
