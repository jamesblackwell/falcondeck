import { useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { ChevronDown } from 'lucide-react-native'

import { OptionSheet, PaletteSwatch, SegmentedControl, Text } from '@/components/ui'
import { SettingsSection, settingsPageStyles } from '@/components/settings'
import {
  DARK_COLOR_THEME_OPTIONS,
  FONT_SCALE_OPTIONS,
  LIGHT_COLOR_THEME_OPTIONS,
  THEME_MODE_OPTIONS,
  colorThemeSwatchColors,
  type DarkColorThemeSetting,
  type LightColorThemeSetting,
  type ThemeModeSetting,
  useAppearanceStore,
} from '@/theme/appearance'

const FONT_SCALE_SEGMENTS = FONT_SCALE_OPTIONS.map((option) => ({
  value: String(option.value),
  label: option.label,
}))

export default function AppearanceSettingsScreen() {
  const themeMode = useAppearanceStore((state) => state.themeMode)
  const lightColorTheme = useAppearanceStore((state) => state.lightColorTheme)
  const darkColorTheme = useAppearanceStore((state) => state.darkColorTheme)
  const fontScale = useAppearanceStore((state) => state.fontScale)
  const { setThemeMode, setLightColorTheme, setDarkColorTheme, setFontScale } =
    useAppearanceStore.getState()
  const { theme } = useUnistyles()
  const [pickingTheme, setPickingTheme] = useState<'light' | 'dark' | null>(null)

  const activeLightTheme =
    LIGHT_COLOR_THEME_OPTIONS.find((option) => option.value === lightColorTheme) ??
    LIGHT_COLOR_THEME_OPTIONS[0]
  const activeDarkTheme =
    DARK_COLOR_THEME_OPTIONS.find((option) => option.value === darkColorTheme) ??
    DARK_COLOR_THEME_OPTIONS[0]

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
                Light theme
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Light theme: ${activeLightTheme.label}`}
                accessibilityHint="Opens the light theme picker"
                onPress={() => setPickingTheme('light')}
                style={({ pressed }) => [styles.paletteField, pressed && styles.pressed]}
              >
                <PaletteSwatch colors={colorThemeSwatchColors(lightColorTheme)} />
                <Text variant="label" color="primary" style={styles.paletteLabel}>
                  {activeLightTheme.label}
                </Text>
                <ChevronDown size={theme.iconSize.sm} color={theme.colors.fg.muted} />
              </Pressable>
            </View>
            <View>
              <Text variant="label" color="muted">
                Dark theme
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Dark theme: ${activeDarkTheme.label}`}
                accessibilityHint="Opens the dark theme picker"
                onPress={() => setPickingTheme('dark')}
                style={({ pressed }) => [styles.paletteField, pressed && styles.pressed]}
              >
                <PaletteSwatch colors={colorThemeSwatchColors(darkColorTheme)} />
                <Text variant="label" color="primary" style={styles.paletteLabel}>
                  {activeDarkTheme.label}
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
      </ScrollView>
      {pickingTheme ? (
        <OptionSheet
          title={`${pickingTheme === 'light' ? 'Light' : 'Dark'} theme`}
          items={(pickingTheme === 'light'
            ? LIGHT_COLOR_THEME_OPTIONS
            : DARK_COLOR_THEME_OPTIONS
          ).map((option) => ({
            value: option.value,
            label: option.label,
            description: option.description,
            swatch: colorThemeSwatchColors(option.value),
          }))}
          selected={pickingTheme === 'light' ? lightColorTheme : darkColorTheme}
          onSelect={(value) => {
            if (pickingTheme === 'light') {
              setLightColorTheme(value as LightColorThemeSetting)
            } else {
              setDarkColorTheme(value as DarkColorThemeSetting)
            }
            setPickingTheme(null)
          }}
          onClose={() => setPickingTheme(null)}
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
