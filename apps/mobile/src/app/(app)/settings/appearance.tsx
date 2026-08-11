import { useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { ChevronDown } from 'lucide-react-native'

import { OptionSheet, PaletteSwatch, SegmentedControl, Text } from '@/components/ui'
import { SettingsSection, settingsPageStyles } from '@/components/settings'
import {
  FONT_SCALE_OPTIONS,
  PALETTE_OPTIONS,
  THEME_MODE_OPTIONS,
  paletteSwatchColors,
  type PaletteSetting,
  type ThemeModeSetting,
  useAppearanceStore,
} from '@/theme/appearance'

const FONT_SCALE_SEGMENTS = FONT_SCALE_OPTIONS.map((option) => ({
  value: String(option.value),
  label: option.label,
}))

export default function AppearanceSettingsScreen() {
  const themeMode = useAppearanceStore((state) => state.themeMode)
  const palette = useAppearanceStore((state) => state.palette)
  const fontScale = useAppearanceStore((state) => state.fontScale)
  const { setThemeMode, setPalette, setFontScale } = useAppearanceStore.getState()
  const { theme, rt } = useUnistyles()
  const [pickingPalette, setPickingPalette] = useState(false)

  // Swatches preview each palette in the mode the phone is actually showing.
  const base = rt.themeName === 'light' ? 'light' : 'dark'
  const activePalette = PALETTE_OPTIONS.find((option) => option.value === palette) ?? PALETTE_OPTIONS[0]

  return (
    <>
      <ScrollView
        style={settingsPageStyles.container}
        contentContainerStyle={settingsPageStyles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        <SettingsSection
          title="Theme & type"
          footer="Appearance is stored on this phone. System follows the device’s light or dark appearance."
        >
          <View style={styles.controls}>
            <SegmentedControl
              label="Theme"
              options={THEME_MODE_OPTIONS}
              selectedValue={themeMode}
              onChange={(value) => setThemeMode(value as ThemeModeSetting)}
            />
            <View>
              <Text variant="label" color="muted">
                Color theme
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Color theme: ${activePalette.label}`}
                accessibilityHint="Opens the palette picker"
                onPress={() => setPickingPalette(true)}
                style={({ pressed }) => [styles.paletteField, pressed && styles.pressed]}
              >
                <PaletteSwatch colors={paletteSwatchColors(palette, base)} />
                <Text variant="label" color="primary" style={styles.paletteLabel}>
                  {activePalette.label}
                </Text>
                <ChevronDown size={theme.iconSize.sm} color={theme.colors.fg.muted} />
              </Pressable>
            </View>
            <SegmentedControl
              label="Text size"
              options={FONT_SCALE_SEGMENTS}
              selectedValue={String(fontScale)}
              onChange={(value) => setFontScale(Number(value))}
            />
          </View>
        </SettingsSection>
        <Text variant="caption" color="faint">
          FalconDeck keeps its mobile font choices intentionally native and readable rather than copying desktop font controls.
        </Text>
      </ScrollView>
      {pickingPalette ? (
        <OptionSheet
          title="Color theme"
          items={PALETTE_OPTIONS.map((option) => ({
            value: option.value,
            label: option.label,
            description: option.description,
            swatch: paletteSwatchColors(option.value, base),
          }))}
          selected={palette}
          onSelect={(value) => {
            setPalette(value as PaletteSetting)
            setPickingPalette(false)
          }}
          onClose={() => setPickingPalette(false)}
        />
      ) : null}
    </>
  )
}

const styles = StyleSheet.create((theme) => ({
  controls: { padding: theme.spacing[4], gap: theme.spacing[5] },
  paletteField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[3],
    minHeight: theme.minTouchTarget,
    marginTop: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    backgroundColor: theme.colors.surface[2],
  },
  paletteLabel: { flex: 1 },
  pressed: { opacity: 0.72 },
}))
