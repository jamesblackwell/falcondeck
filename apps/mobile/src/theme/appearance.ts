/**
 * Device-local appearance preferences: theme mode and text size.
 * Persisted in MMKV so unistyles can be configured synchronously at boot
 * (before first render), then updated live from the settings screen.
 */
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
  | 'nord'
  | 'one'
  | 'rose-pine'
  | 'solarized'
  | 'tokyo-night'

export type MobileAppearance = {
  themeMode: ThemeModeSetting
  palette: PaletteSetting
  fontScale: number
}

export const THEME_MODE_OPTIONS: Array<{ value: ThemeModeSetting; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

export const PALETTE_COLORS: Record<
  PaletteSetting,
  { dark: typeof darkColors; light: typeof darkColors }
> = {
  falcon: { dark: darkColors, light: lightColors },
  catppuccin: { dark: catppuccinDarkColors, light: catppuccinLightColors },
  dracula: { dark: draculaDarkColors, light: draculaLightColors },
  gruvbox: { dark: gruvboxDarkColors, light: gruvboxLightColors },
  nord: { dark: nordDarkColors, light: nordLightColors },
  one: { dark: oneDarkColors, light: oneLightColors },
  'rose-pine': { dark: rosePineDarkColors, light: rosePineLightColors },
  solarized: { dark: solarizedDarkColors, light: solarizedLightColors },
  'tokyo-night': { dark: tokyoNightDarkColors, light: tokyoNightLightColors },
}

/** Falcon leads as the default; the rest are alphabetical. Descriptions mirror
    the desktop copy in packages/ui/src/lib/appearance.ts. */
export const PALETTE_OPTIONS: Array<{
  value: PaletteSetting
  label: string
  description: string
}> = [
  { value: 'falcon', label: 'Falcon', description: 'Deep black with an emerald accent.' },
  { value: 'catppuccin', label: 'Catppuccin', description: 'Soft pastel mauve — Mocha and Latte.' },
  { value: 'dracula', label: 'Dracula', description: 'Neon purple on graphite.' },
  { value: 'gruvbox', label: 'Gruvbox', description: 'Warm, retro groove.' },
  { value: 'nord', label: 'Nord', description: 'Arctic blue-grey calm.' },
  { value: 'one', label: 'One', description: 'The classic editor grey and blue.' },
  { value: 'rose-pine', label: 'Rosé Pine', description: 'Muted rose and pine.' },
  { value: 'solarized', label: 'Solarized', description: 'Precision-tuned cyan and cream.' },
  { value: 'tokyo-night', label: 'Tokyo Night', description: 'Cool indigo dusk.' },
]

/** The four tones a palette swatch paints, read straight off the palette so a
    chip can never drift from the theme it advertises. */
export function paletteSwatchColors(palette: PaletteSetting, base: 'light' | 'dark') {
  const colors = PALETTE_COLORS[palette][base]
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
  const raw = (value ?? {}) as Partial<MobileAppearance>
  return {
    themeMode:
      raw.themeMode === 'light' || raw.themeMode === 'dark' ? raw.themeMode : 'system',
    palette: PALETTE_OPTIONS.some((o) => o.value === raw.palette)
      ? (raw.palette as PaletteSetting)
      : 'falcon',
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

export function buildTheme(base: 'light' | 'dark', fontScale: number, palette: PaletteSetting) {
  return {
    colors: PALETTE_COLORS[palette][base],
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
  setPalette: (palette: PaletteSetting) => void
  setFontScale: (scale: number) => void
}

function persist(next: MobileAppearance) {
  setJson(STORAGE_KEY, next)
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
  },

  setPalette: (palette) => {
    const next = normalizeAppearance({ ...get(), palette })
    persist(next)
    set(next)
    const paletteColors = PALETTE_COLORS[next.palette]
    UnistylesRuntime.updateTheme('dark', (theme) => ({ ...theme, colors: paletteColors.dark }))
    UnistylesRuntime.updateTheme('light', (theme) => ({ ...theme, colors: paletteColors.light }))
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
