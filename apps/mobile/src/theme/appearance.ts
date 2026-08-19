/**
 * Device-local appearance preferences: theme mode, per-mode color themes, and text size.
 * Persisted in MMKV so unistyles can be configured synchronously at boot
 * (before first render), then updated live from the settings screen.
 */
import { Appearance } from 'react-native'
import { UnistylesRuntime } from 'react-native-unistyles'
import { create } from 'zustand'

import { getJson, setJson } from '@/storage/mmkv'

import {
  darkColors,
  lightColors,
  catppuccinDarkColors,
  catppuccinLightColors,
  draculaDarkColors,
  draculaLightColors,
  gruvboxDarkColors,
  gruvboxLightColors,
  matrixDarkColors,
  nordDarkColors,
  nordLightColors,
  oneDarkColors,
  oneLightColors,
  rosePineDarkColors,
  rosePineLightColors,
  solarizedDarkColors,
  solarizedLightColors,
  tokyoNightDarkColors,
  tokyoNightLightColors,
  spacing,
  radius,
  fontSize,
  lineHeight,
  fontFamily,
  shadow,
  duration,
  iconSize,
  minTouchTarget,
} from './tokens'

export type ThemeModeSetting = 'system' | 'light' | 'dark'
export type PaletteSetting =
  | 'falcon'
  | 'catppuccin'
  | 'dracula'
  | 'gruvbox'
  | 'matrix'
  | 'nord'
  | 'one'
  | 'rose-pine'
  | 'solarized'
  | 'tokyo-night'
export type LightColorThemeSetting =
  | 'falcon-light'
  | 'catppuccin-latte'
  | 'alucard'
  | 'gruvbox-light'
  | 'nord-light'
  | 'one-light'
  | 'rose-pine-dawn'
  | 'solarized-light'
  | 'tokyo-night-light'
export type DarkColorThemeSetting =
  | 'falcon-dark'
  | 'catppuccin-mocha'
  | 'dracula'
  | 'gruvbox-dark'
  | 'matrix'
  | 'nord'
  | 'one-dark'
  | 'rose-pine'
  | 'solarized-dark'
  | 'tokyo-night'
export type ColorThemeSetting = LightColorThemeSetting | DarkColorThemeSetting

export type MobileAppearance = {
  themeMode: ThemeModeSetting
  lightColorTheme: LightColorThemeSetting
  darkColorTheme: DarkColorThemeSetting
  fontScale: number
}

export const THEME_MODE_OPTIONS: Array<{ value: ThemeModeSetting; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

export const COLOR_THEME_COLORS: Record<ColorThemeSetting, typeof darkColors> = {
  'falcon-light': lightColors,
  'catppuccin-latte': catppuccinLightColors,
  alucard: draculaLightColors,
  'gruvbox-light': gruvboxLightColors,
  'nord-light': nordLightColors,
  'one-light': oneLightColors,
  'rose-pine-dawn': rosePineLightColors,
  'solarized-light': solarizedLightColors,
  'tokyo-night-light': tokyoNightLightColors,
  'falcon-dark': darkColors,
  'catppuccin-mocha': catppuccinDarkColors,
  dracula: draculaDarkColors,
  'gruvbox-dark': gruvboxDarkColors,
  matrix: matrixDarkColors,
  nord: nordDarkColors,
  'one-dark': oneDarkColors,
  'rose-pine': rosePineDarkColors,
  'solarized-dark': solarizedDarkColors,
  'tokyo-night': tokyoNightDarkColors,
}

type ColorThemeOptionBase = {
  label: string
  description: string
  palette: PaletteSetting
}
export type ColorThemeOption =
  | (ColorThemeOptionBase & { value: LightColorThemeSetting; appearance: 'light' })
  | (ColorThemeOptionBase & { value: DarkColorThemeSetting; appearance: 'dark' })

export const LIGHT_COLOR_THEME_OPTIONS: Array<Extract<ColorThemeOption, { appearance: 'light' }>> = [
  { value: 'falcon-light', label: 'Falcon Light', description: 'Crisp white with deep emerald.', appearance: 'light', palette: 'falcon' },
  { value: 'catppuccin-latte', label: 'Catppuccin Latte', description: 'Warm, soft pastels.', appearance: 'light', palette: 'catppuccin' },
  { value: 'alucard', label: 'Alucard', description: 'Violet and warm ivory.', appearance: 'light', palette: 'dracula' },
  { value: 'gruvbox-light', label: 'Gruvbox Light', description: 'Warm retro parchment.', appearance: 'light', palette: 'gruvbox' },
  { value: 'nord-light', label: 'Nord Light', description: 'Cool arctic greys.', appearance: 'light', palette: 'nord' },
  { value: 'one-light', label: 'One Light', description: 'Classic editor grey and blue.', appearance: 'light', palette: 'one' },
  { value: 'rose-pine-dawn', label: 'Rosé Pine Dawn', description: 'Muted rose and pine.', appearance: 'light', palette: 'rose-pine' },
  { value: 'solarized-light', label: 'Solarized Light', description: 'Precision-tuned cyan and cream.', appearance: 'light', palette: 'solarized' },
  { value: 'tokyo-night-light', label: 'Tokyo Night Light', description: 'Pale blue-grey and indigo.', appearance: 'light', palette: 'tokyo-night' },
]

export const DARK_COLOR_THEME_OPTIONS: Array<Extract<ColorThemeOption, { appearance: 'dark' }>> = [
  { value: 'falcon-dark', label: 'Falcon Dark', description: 'Deep black with emerald.', appearance: 'dark', palette: 'falcon' },
  { value: 'catppuccin-mocha', label: 'Catppuccin Mocha', description: 'Soft pastel mauve.', appearance: 'dark', palette: 'catppuccin' },
  { value: 'dracula', label: 'Dracula', description: 'Neon purple on graphite.', appearance: 'dark', palette: 'dracula' },
  { value: 'gruvbox-dark', label: 'Gruvbox Dark', description: 'Warm retro charcoal.', appearance: 'dark', palette: 'gruvbox' },
  { value: 'matrix', label: 'Matrix', description: 'Digital-rain green on near-black.', appearance: 'dark', palette: 'matrix' },
  { value: 'nord', label: 'Nord', description: 'Arctic blue-grey calm.', appearance: 'dark', palette: 'nord' },
  { value: 'one-dark', label: 'One Dark', description: 'Classic editor grey and blue.', appearance: 'dark', palette: 'one' },
  { value: 'rose-pine', label: 'Rosé Pine', description: 'Muted rose and pine.', appearance: 'dark', palette: 'rose-pine' },
  { value: 'solarized-dark', label: 'Solarized Dark', description: 'Precision-tuned cyan and teal.', appearance: 'dark', palette: 'solarized' },
  { value: 'tokyo-night', label: 'Tokyo Night', description: 'Cool indigo dusk.', appearance: 'dark', palette: 'tokyo-night' },
]

export const COLOR_THEME_OPTIONS: ColorThemeOption[] = [
  ...LIGHT_COLOR_THEME_OPTIONS,
  ...DARK_COLOR_THEME_OPTIONS,
]

const LIGHT_COLOR_THEME_IDS = new Set(LIGHT_COLOR_THEME_OPTIONS.map((option) => option.value))
const DARK_COLOR_THEME_IDS = new Set(DARK_COLOR_THEME_OPTIONS.map((option) => option.value))

const LEGACY_PALETTE_THEMES: Record<
  Exclude<PaletteSetting, 'matrix'>,
  { light: LightColorThemeSetting; dark: DarkColorThemeSetting }
> = {
  falcon: { light: 'falcon-light', dark: 'falcon-dark' },
  catppuccin: { light: 'catppuccin-latte', dark: 'catppuccin-mocha' },
  dracula: { light: 'alucard', dark: 'dracula' },
  gruvbox: { light: 'gruvbox-light', dark: 'gruvbox-dark' },
  nord: { light: 'nord-light', dark: 'nord' },
  one: { light: 'one-light', dark: 'one-dark' },
  'rose-pine': { light: 'rose-pine-dawn', dark: 'rose-pine' },
  solarized: { light: 'solarized-light', dark: 'solarized-dark' },
  'tokyo-night': { light: 'tokyo-night-light', dark: 'tokyo-night' },
}

/** The four tones a palette swatch paints, read straight off the palette so a
    chip can never drift from the theme it advertises. */
export function colorThemeSwatchColors(colorTheme: ColorThemeSetting) {
  const colors = COLOR_THEME_COLORS[colorTheme]
  return {
    bg: colors.surface[1],
    surface: colors.surface[2],
    fg: colors.fg.primary,
    accent: colors.accent.default,
  }
}

export const FONT_SCALE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0.9, label: 'Small' },
  { value: 1, label: 'Default' },
  { value: 1.1, label: 'Large' },
  { value: 1.2, label: 'XL' },
]

const STORAGE_KEY = 'fd-appearance'

export function normalizeAppearance(value: unknown): MobileAppearance {
  const raw = (value ?? {}) as Partial<MobileAppearance> & { palette?: string }
  const legacyThemes =
    raw.palette && raw.palette in LEGACY_PALETTE_THEMES
      ? LEGACY_PALETTE_THEMES[raw.palette as keyof typeof LEGACY_PALETTE_THEMES]
      : null
  return {
    themeMode:
      raw.themeMode === 'light' || raw.themeMode === 'dark' ? raw.themeMode : 'system',
    lightColorTheme:
      raw.lightColorTheme && LIGHT_COLOR_THEME_IDS.has(raw.lightColorTheme)
        ? raw.lightColorTheme
        : legacyThemes?.light ?? 'falcon-light',
    darkColorTheme:
      raw.darkColorTheme && DARK_COLOR_THEME_IDS.has(raw.darkColorTheme)
        ? raw.darkColorTheme
        : legacyThemes?.dark ?? 'falcon-dark',
    fontScale: FONT_SCALE_OPTIONS.some((o) => o.value === raw.fontScale)
      ? (raw.fontScale as number)
      : 1,
  }
}

export function readAppearance(): MobileAppearance {
  return normalizeAppearance(getJson<MobileAppearance>(STORAGE_KEY))
}

function scaledFontSize(scale: number): typeof fontSize {
  if (scale === 1) return fontSize
  const entries = Object.entries(fontSize).map(([key, value]) => [
    key,
    Math.round(value * scale * 2) / 2,
  ])
  return Object.fromEntries(entries) as unknown as typeof fontSize
}

// Softer elevation for light surfaces; dark keeps the deeper stack.
const lightShadow: typeof shadow = {
  sm: { ...shadow.sm, shadowOpacity: 0.08 },
  md: { ...shadow.md, shadowOpacity: 0.1 },
  lg: { ...shadow.lg, shadowOpacity: 0.14 },
}

export function buildTheme(
  base: 'light' | 'dark',
  fontScale: number,
  colorTheme: ColorThemeSetting,
) {
  return {
    // Materials (blur tints, hairline highlights) can't be expressed as a flat
    // palette entry, so components branch on the base mode.
    isDark: base === 'dark',
    colors: COLOR_THEME_COLORS[colorTheme],
    spacing,
    radius,
    fontSize: scaledFontSize(fontScale),
    lineHeight,
    fontFamily,
    shadow: base === 'light' ? lightShadow : shadow,
    duration,
    iconSize,
    minTouchTarget,
  } as const
}

type AppearanceStore = MobileAppearance & {
  setThemeMode: (mode: ThemeModeSetting) => void
  setLightColorTheme: (colorTheme: LightColorThemeSetting) => void
  setDarkColorTheme: (colorTheme: DarkColorThemeSetting) => void
  setFontScale: (scale: number) => void
}

function persist(next: MobileAppearance) {
  setJson(STORAGE_KEY, next)
}

/**
 * Point the platform's own trait collection at the chosen mode. Native chrome
 * we do not draw — the stack header, alerts, the keyboard, the status bar —
 * follows the OS appearance, not our theme, so picking Dark inside a phone set
 * to Light used to leave a white nav bar above a black screen.
 */
export function applyNativeColorScheme(mode: ThemeModeSetting) {
  Appearance.setColorScheme(mode === 'system' ? null : mode)
}

export const useAppearanceStore = create<AppearanceStore>((set, get) => ({
  ...readAppearance(),

  setThemeMode: (themeMode) => {
    const next = normalizeAppearance({ ...get(), themeMode })
    persist(next)
    set(next)
    if (next.themeMode === 'system') {
      UnistylesRuntime.setAdaptiveThemes(true)
    } else {
      UnistylesRuntime.setAdaptiveThemes(false)
      UnistylesRuntime.setTheme(next.themeMode)
    }
    applyNativeColorScheme(next.themeMode)
  },

  setLightColorTheme: (lightColorTheme) => {
    const next = normalizeAppearance({ ...get(), lightColorTheme })
    persist(next)
    set(next)
    UnistylesRuntime.updateTheme('light', (theme) => ({
      ...theme,
      colors: COLOR_THEME_COLORS[next.lightColorTheme],
    }))
  },

  setDarkColorTheme: (darkColorTheme) => {
    const next = normalizeAppearance({ ...get(), darkColorTheme })
    persist(next)
    set(next)
    UnistylesRuntime.updateTheme('dark', (theme) => ({
      ...theme,
      colors: COLOR_THEME_COLORS[next.darkColorTheme],
    }))
  },

  setFontScale: (fontScale) => {
    const next = normalizeAppearance({ ...get(), fontScale })
    persist(next)
    set(next)
    const scaled = scaledFontSize(next.fontScale)
    UnistylesRuntime.updateTheme('dark', (theme) => ({ ...theme, fontSize: scaled }))
    UnistylesRuntime.updateTheme('light', (theme) => ({ ...theme, fontSize: scaled }))
  },
}))
