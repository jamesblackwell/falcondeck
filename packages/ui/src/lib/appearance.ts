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
  fontScale: 1.05,
}

export const THEME_OPTIONS: Array<{ value: ThemeSetting; label: string; description: string }> = [
  { value: 'system', label: 'System', description: 'Follow this device’s appearance.' },
  { value: 'light', label: 'Light', description: 'Always use the light theme.' },
  { value: 'dark', label: 'Dark', description: 'Always use the dark theme.' },
]

export type PalettePreview = { bg: string; surface: string; fg: string; accent: string }

/**
 * Falcon leads as the default; the rest are alphabetical so a growing list of
 * editor classics stays scannable. Each preview quartet feeds the swatch in the
 * picker — canvas, raised surface, text, accent — pulled from the palette's own
 * bg-1 / bg-2 / fg-0 / accent so the chip never drifts from the real theme.
 */
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
    value: 'catppuccin',
    label: 'Catppuccin',
    description: 'Soft pastel mauve — inspired by Catppuccin Mocha and Latte.',
    preview: {
      dark: { bg: '#1e1e2e', surface: '#282839', fg: '#cdd6f4', accent: '#cba6f7' },
      light: { bg: '#eff1f5', surface: '#ffffff', fg: '#4c4f69', accent: '#8839ef' },
    },
  },
  {
    value: 'dracula',
    label: 'Dracula',
    description: 'Neon purple on graphite — inspired by Dracula and Alucard.',
    preview: {
      dark: { bg: '#282a36', surface: '#343746', fg: '#f8f8f2', accent: '#bd93f9' },
      light: { bg: '#fbf8e8', surface: '#fffbeb', fg: '#1f1f1f', accent: '#644ac9' },
    },
  },
  {
    value: 'gruvbox',
    label: 'Gruvbox',
    description: 'Warm, retro groove — inspired by the classic Gruvbox scheme.',
    preview: {
      dark: { bg: '#282828', surface: '#32302f', fg: '#fbf1c7', accent: '#8ec07c' },
      light: { bg: '#f9efc6', surface: '#fbf1c7', fg: '#282828', accent: '#427b58' },
    },
  },
  {
    value: 'nord',
    label: 'Nord',
    description: 'Arctic blue-grey calm — inspired by the Nord scheme.',
    preview: {
      dark: { bg: '#2e3440', surface: '#3b4252', fg: '#eceff4', accent: '#88c0d0' },
      light: { bg: '#e9edf4', surface: '#f8fafc', fg: '#2e3440', accent: '#4c6f96' },
    },
  },
  {
    value: 'one',
    label: 'One',
    description: 'The classic editor grey and blue — inspired by Atom One.',
    preview: {
      dark: { bg: '#282c34', surface: '#31353f', fg: '#dcdfe4', accent: '#61afef' },
      light: { bg: '#f2f2f3', surface: '#fafafa', fg: '#383a42', accent: '#3568d4' },
    },
  },
  {
    value: 'rose-pine',
    label: 'Rosé Pine',
    description: 'Muted rose and pine — inspired by Rosé Pine and Dawn.',
    preview: {
      dark: { bg: '#191724', surface: '#1f1d2e', fg: '#e0def4', accent: '#c4a7e7' },
      light: { bg: '#faf4ed', surface: '#fffaf3', fg: '#4a4566', accent: '#907aa9' },
    },
  },
  {
    value: 'solarized',
    label: 'Solarized',
    description: 'Precision-tuned cyan and cream — inspired by Solarized.',
    preview: {
      dark: { bg: '#002b36', surface: '#073642', fg: '#fdf6e3', accent: '#268bd2' },
      light: { bg: '#f8f2e0', surface: '#fdf6e3', fg: '#002b36', accent: '#1a6c9c' },
    },
  },
  {
    value: 'tokyo-night',
    label: 'Tokyo Night',
    description: 'Cool indigo dusk — inspired by the Tokyo Night scheme.',
    preview: {
      dark: { bg: '#1a1b26', surface: '#24283b', fg: '#c0caf5', accent: '#7aa2f7' },
      light: { bg: '#e4e6ee', surface: '#eff1f7', fg: '#2e3350', accent: '#2e7de9' },
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
  { value: 0.95, label: 'Small' },
  { value: 1.05, label: 'Default' },
  { value: 1.15, label: 'Large' },
  { value: 1.25, label: 'Extra large' },
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
      : DEFAULT_APPEARANCE.fontScale,
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

function darkMediaQuery(): MediaQueryList | null {
  // jsdom and some embedded webviews ship no matchMedia; callers fall back to
  // the dark default rather than throwing mid-render.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(DARK_QUERY)
}

export function resolveTheme(setting: ThemeSetting): ResolvedTheme {
  if (setting === 'light' || setting === 'dark') return setting
  return darkMediaQuery()?.matches ? 'dark' : 'light'
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
  root.style.setProperty('--fd-font-scale', String(settings.fontScale))
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

  const media = darkMediaQuery()
  const onSystemChange = () => {
    if (current.theme === 'system') {
      applyAppearance(current)
      notify()
    }
  }
  if (typeof media?.addEventListener === 'function') {
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
