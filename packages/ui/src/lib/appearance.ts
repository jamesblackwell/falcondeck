import { useSyncExternalStore } from 'react'

/* ================================================================
   Appearance settings — theme, fonts, and text sizing.

   Device-local by design: system theme, display size, and font taste
   differ per machine, so these persist to localStorage rather than
   the daemon-owned falcondeck.json. Applied as a `data-theme`
   attribute plus CSS custom-property overrides on <html>, which the
   token layer in styles.css picks up.
   ================================================================ */

export type ThemeSetting = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'
export type PaletteSetting = 'falcon' | 'gruvbox' | 'tokyo-night'
export type SansFontSetting = 'geist' | 'system' | 'serif'
export type MonoFontSetting = 'geist-mono' | 'system-mono'

export type AppearanceSettings = {
  theme: ThemeSetting
  palette: PaletteSetting
  sansFont: SansFontSetting
  monoFont: MonoFontSetting
  /** Multiplier applied to the --fd-text-* scale. */
  fontScale: number
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: 'system',
  palette: 'falcon',
  sansFont: 'geist',
  monoFont: 'geist-mono',
  fontScale: 1,
}

export const THEME_OPTIONS: Array<{ value: ThemeSetting; label: string; description: string }> = [
  { value: 'system', label: 'System', description: 'Follow this device’s appearance.' },
  { value: 'light', label: 'Light', description: 'Always use the light theme.' },
  { value: 'dark', label: 'Dark', description: 'Always use the dark theme.' },
]

export type PalettePreview = { bg: string; surface: string; fg: string; accent: string }

export const PALETTE_OPTIONS: Array<{
  value: PaletteSetting
  label: string
  description: string
  preview: { dark: PalettePreview; light: PalettePreview }
}> = [
  {
    value: 'falcon',
    label: 'Falcon',
    description: 'Deep black with an emerald accent — the FalconDeck default.',
    preview: {
      dark: { bg: '#111113', surface: '#1a1a1f', fg: '#f4f4f6', accent: '#34d399' },
      light: { bg: '#fbfbfc', surface: '#ffffff', fg: '#17171c', accent: '#059669' },
    },
  },
  {
    value: 'gruvbox',
    label: 'Gruvbox',
    description: 'Warm, retro groove — inspired by the classic Gruvbox scheme.',
    preview: {
      dark: { bg: '#282828', surface: '#32302f', fg: '#ebdbb2', accent: '#8ec07c' },
      light: { bg: '#f9efc6', surface: '#fbf1c7', fg: '#3c3836', accent: '#427b58' },
    },
  },
  {
    value: 'tokyo-night',
    label: 'Tokyo Night',
    description: 'Cool indigo dusk — inspired by the Tokyo Night scheme.',
    preview: {
      dark: { bg: '#1a1b26', surface: '#24283b', fg: '#a9b1d6', accent: '#7aa2f7' },
      light: { bg: '#e4e6ee', surface: '#eff1f7', fg: '#40456b', accent: '#2e7de9' },
    },
  },
]

export const SANS_FONT_OPTIONS: Array<{
  value: SansFontSetting
  label: string
  stack: string
}> = [
  {
    value: 'geist',
    label: 'Geist',
    stack: '"Geist", "Inter", "SF Pro Display", "Segoe UI", system-ui, sans-serif',
  },
  {
    value: 'system',
    label: 'System',
    stack: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif',
  },
  {
    value: 'serif',
    label: 'Serif',
    stack: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  },
]

export const MONO_FONT_OPTIONS: Array<{
  value: MonoFontSetting
  label: string
  stack: string
}> = [
  {
    value: 'geist-mono',
    label: 'Geist Mono',
    stack: '"Geist Mono", "SF Mono", "JetBrains Mono", "Cascadia Code", ui-monospace, monospace',
  },
  {
    value: 'system-mono',
    label: 'System',
    stack: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  },
]

export const FONT_SCALE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0.9, label: 'Small' },
  { value: 1, label: 'Default' },
  { value: 1.1, label: 'Large' },
  { value: 1.2, label: 'Extra large' },
]

const STORAGE_KEY = 'fd-appearance'
const DARK_QUERY = '(prefers-color-scheme: dark)'

export function normalizeAppearance(value: unknown): AppearanceSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_APPEARANCE }
  const raw = value as Partial<AppearanceSettings>
  return {
    theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'system',
    palette: PALETTE_OPTIONS.some((o) => o.value === raw.palette)
      ? (raw.palette as PaletteSetting)
      : 'falcon',
    sansFont: SANS_FONT_OPTIONS.some((o) => o.value === raw.sansFont)
      ? (raw.sansFont as SansFontSetting)
      : 'geist',
    monoFont: MONO_FONT_OPTIONS.some((o) => o.value === raw.monoFont)
      ? (raw.monoFont as MonoFontSetting)
      : 'geist-mono',
    fontScale: FONT_SCALE_OPTIONS.some((o) => o.value === raw.fontScale)
      ? (raw.fontScale as number)
      : 1,
  }
}

function loadAppearance(): AppearanceSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return normalizeAppearance(raw ? JSON.parse(raw) : null)
  } catch {
    return { ...DEFAULT_APPEARANCE }
  }
}

function saveAppearance(settings: AppearanceSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Storage may be unavailable (private mode); the session still themes.
  }
}

export function resolveTheme(setting: ThemeSetting): ResolvedTheme {
  if (setting === 'light' || setting === 'dark') return setting
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

function applyAppearance(settings: AppearanceSettings) {
  const root = document.documentElement
  root.dataset.theme = resolveTheme(settings.theme)
  if (settings.palette === 'falcon') {
    delete root.dataset.palette
  } else {
    root.dataset.palette = settings.palette
  }

  const sans = SANS_FONT_OPTIONS.find((o) => o.value === settings.sansFont)
  const mono = MONO_FONT_OPTIONS.find((o) => o.value === settings.monoFont)
  if (settings.sansFont !== 'geist' && sans) {
    root.style.setProperty('--fd-font-sans', sans.stack)
  } else {
    root.style.removeProperty('--fd-font-sans')
  }
  if (settings.monoFont !== 'geist-mono' && mono) {
    root.style.setProperty('--fd-font-mono', mono.stack)
  } else {
    root.style.removeProperty('--fd-font-mono')
  }
  if (settings.fontScale !== 1) {
    root.style.setProperty('--fd-font-scale', String(settings.fontScale))
  } else {
    root.style.removeProperty('--fd-font-scale')
  }
}

/* --- Tiny external store so any component can read/update settings --- */

let current: AppearanceSettings = { ...DEFAULT_APPEARANCE }
let initialized = false
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

/**
 * Load persisted settings, apply them to the document, and keep the resolved
 * theme in sync with the OS while the preference is "system". Call once at
 * app boot, before rendering.
 */
export function initAppearance(): AppearanceSettings {
  if (initialized) return current
  initialized = true
  current = loadAppearance()
  applyAppearance(current)

  const media = window.matchMedia(DARK_QUERY)
  const onSystemChange = () => {
    if (current.theme === 'system') {
      applyAppearance(current)
      notify()
    }
  }
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', onSystemChange)
  }
  return current
}

export function getAppearance(): AppearanceSettings {
  return current
}

export function updateAppearance(patch: Partial<AppearanceSettings>) {
  current = normalizeAppearance({ ...current, ...patch })
  saveAppearance(current)
  applyAppearance(current)
  notify()
}

/**
 * Observe appearance changes. Fires after the document has been restyled, and
 * — unlike the `useAppearance` hook — also for OS appearance flips under the
 * "system" setting, where the settings object itself is unchanged.
 */
export function subscribeAppearance(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Reactive hook over the appearance store. */
export function useAppearance(): AppearanceSettings {
  return useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance)
}
