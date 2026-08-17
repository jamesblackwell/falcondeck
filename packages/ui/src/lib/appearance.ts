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
export type SansFontSetting = 'geist' | 'system' | 'serif'
export type MonoFontSetting = 'geist-mono' | 'system-mono'

export type AppearanceSettings = {
  theme: ThemeSetting
  lightColorTheme: LightColorThemeSetting
  darkColorTheme: DarkColorThemeSetting
  sansFont: SansFontSetting
  monoFont: MonoFontSetting
  /** Multiplier applied to the --fd-text-* scale. */
  fontScale: number
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: 'system',
  lightColorTheme: 'falcon-light',
  darkColorTheme: 'falcon-dark',
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
type ColorThemeOptionBase = {
  label: string
  description: string
  palette: PaletteSetting
  preview: PalettePreview
}
export type ColorThemeOption =
  | (ColorThemeOptionBase & { value: LightColorThemeSetting; appearance: 'light' })
  | (ColorThemeOptionBase & { value: DarkColorThemeSetting; appearance: 'dark' })
type LightColorThemeOption = Extract<ColorThemeOption, { appearance: 'light' }>
type DarkColorThemeOption = Extract<ColorThemeOption, { appearance: 'dark' }>

export const LIGHT_COLOR_THEME_OPTIONS: LightColorThemeOption[] = [
  {
    value: 'falcon-light',
    label: 'Falcon Light',
    description: 'Crisp white surfaces with a deep emerald accent.',
    appearance: 'light',
    palette: 'falcon',
    preview: { bg: '#fbfbfc', surface: '#ffffff', fg: '#17171c', accent: '#059669' },
  },
  {
    value: 'catppuccin-latte',
    label: 'Catppuccin Latte',
    description: 'Warm, soft pastels on a pale canvas.',
    appearance: 'light',
    palette: 'catppuccin',
    preview: { bg: '#eff1f5', surface: '#ffffff', fg: '#4c4f69', accent: '#8839ef' },
  },
  {
    value: 'alucard',
    label: 'Alucard',
    description: 'Dracula-inspired ink and violet on warm ivory.',
    appearance: 'light',
    palette: 'dracula',
    preview: { bg: '#fbf8e8', surface: '#fffbeb', fg: '#1f1f1f', accent: '#644ac9' },
  },
  {
    value: 'gruvbox-light',
    label: 'Gruvbox Light',
    description: 'Warm retro ink on a parchment-like canvas.',
    appearance: 'light',
    palette: 'gruvbox',
    preview: { bg: '#f9efc6', surface: '#fbf1c7', fg: '#282828', accent: '#427b58' },
  },
  {
    value: 'nord-light',
    label: 'Nord Light',
    description: 'Cool arctic greys with a restrained blue accent.',
    appearance: 'light',
    palette: 'nord',
    preview: { bg: '#e9edf4', surface: '#f8fafc', fg: '#2e3440', accent: '#4c6f96' },
  },
  {
    value: 'one-light',
    label: 'One Light',
    description: 'Classic editor grey and blue on a clean canvas.',
    appearance: 'light',
    palette: 'one',
    preview: { bg: '#f2f2f3', surface: '#fafafa', fg: '#383a42', accent: '#3568d4' },
  },
  {
    value: 'rose-pine-dawn',
    label: 'Rosé Pine Dawn',
    description: 'Muted rose and pine on a warm morning canvas.',
    appearance: 'light',
    palette: 'rose-pine',
    preview: { bg: '#faf4ed', surface: '#fffaf3', fg: '#4a4566', accent: '#907aa9' },
  },
  {
    value: 'solarized-light',
    label: 'Solarized Light',
    description: 'Precision-tuned cyan and cream.',
    appearance: 'light',
    palette: 'solarized',
    preview: { bg: '#f8f2e0', surface: '#fdf6e3', fg: '#002b36', accent: '#1a6c9c' },
  },
  {
    value: 'tokyo-night-light',
    label: 'Tokyo Night Light',
    description: 'Cool indigo structure on a pale blue-grey canvas.',
    appearance: 'light',
    palette: 'tokyo-night',
    preview: { bg: '#e4e6ee', surface: '#eff1f7', fg: '#2e3350', accent: '#2e7de9' },
  },
]

export const DARK_COLOR_THEME_OPTIONS: DarkColorThemeOption[] = [
  {
    value: 'falcon-dark',
    label: 'Falcon Dark',
    description: 'Deep black with an emerald accent — the FalconDeck default.',
    appearance: 'dark',
    palette: 'falcon',
    preview: { bg: '#111113', surface: '#1a1a1f', fg: '#f4f4f6', accent: '#34d399' },
  },
  {
    value: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    description: 'Soft pastel mauve on a deep blue-grey canvas.',
    appearance: 'dark',
    palette: 'catppuccin',
    preview: { bg: '#1e1e2e', surface: '#282839', fg: '#cdd6f4', accent: '#cba6f7' },
  },
  {
    value: 'dracula',
    label: 'Dracula',
    description: 'Neon purple on graphite.',
    appearance: 'dark',
    palette: 'dracula',
    preview: { bg: '#282a36', surface: '#343746', fg: '#f8f8f2', accent: '#bd93f9' },
  },
  {
    value: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    description: 'Warm, retro groove on charcoal.',
    appearance: 'dark',
    palette: 'gruvbox',
    preview: { bg: '#282828', surface: '#32302f', fg: '#fbf1c7', accent: '#8ec07c' },
  },
  {
    value: 'matrix',
    label: 'Matrix',
    description: 'Digital-rain green on near-black.',
    appearance: 'dark',
    palette: 'matrix',
    preview: { bg: '#0b120d', surface: '#111b13', fg: '#d8f7df', accent: '#35f477' },
  },
  {
    value: 'nord',
    label: 'Nord',
    description: 'Arctic blue-grey calm.',
    appearance: 'dark',
    palette: 'nord',
    preview: { bg: '#2e3440', surface: '#3b4252', fg: '#eceff4', accent: '#88c0d0' },
  },
  {
    value: 'one-dark',
    label: 'One Dark',
    description: 'Classic editor grey and blue.',
    appearance: 'dark',
    palette: 'one',
    preview: { bg: '#282c34', surface: '#31353f', fg: '#dcdfe4', accent: '#61afef' },
  },
  {
    value: 'rose-pine',
    label: 'Rosé Pine',
    description: 'Muted rose and pine on deep aubergine.',
    appearance: 'dark',
    palette: 'rose-pine',
    preview: { bg: '#191724', surface: '#1f1d2e', fg: '#e0def4', accent: '#c4a7e7' },
  },
  {
    value: 'solarized-dark',
    label: 'Solarized Dark',
    description: 'Precision-tuned cyan on deep teal.',
    appearance: 'dark',
    palette: 'solarized',
    preview: { bg: '#002b36', surface: '#073642', fg: '#fdf6e3', accent: '#268bd2' },
  },
  {
    value: 'tokyo-night',
    label: 'Tokyo Night',
    description: 'Cool indigo dusk.',
    appearance: 'dark',
    palette: 'tokyo-night',
    preview: { bg: '#1a1b26', surface: '#24283b', fg: '#c0caf5', accent: '#7aa2f7' },
  },
]

export const COLOR_THEME_OPTIONS: ColorThemeOption[] = [
  ...LIGHT_COLOR_THEME_OPTIONS,
  ...DARK_COLOR_THEME_OPTIONS,
]

const LIGHT_COLOR_THEME_IDS = new Set<LightColorThemeSetting>(
  LIGHT_COLOR_THEME_OPTIONS.map((option) => option.value),
)
const DARK_COLOR_THEME_IDS = new Set<DarkColorThemeSetting>(
  DARK_COLOR_THEME_OPTIONS.map((option) => option.value),
)

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
  const raw = value as Partial<AppearanceSettings> & { palette?: string }
  const legacyThemes =
    raw.palette && raw.palette in LEGACY_PALETTE_THEMES
      ? LEGACY_PALETTE_THEMES[raw.palette as keyof typeof LEGACY_PALETTE_THEMES]
      : null
  return {
    theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'system',
    lightColorTheme:
      raw.lightColorTheme && LIGHT_COLOR_THEME_IDS.has(raw.lightColorTheme)
        ? raw.lightColorTheme
        : legacyThemes?.light ?? DEFAULT_APPEARANCE.lightColorTheme,
    darkColorTheme:
      raw.darkColorTheme && DARK_COLOR_THEME_IDS.has(raw.darkColorTheme)
        ? raw.darkColorTheme
        : legacyThemes?.dark ?? DEFAULT_APPEARANCE.darkColorTheme,
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

export function resolveColorTheme(
  settings: AppearanceSettings,
  appearance = resolveTheme(settings.theme),
): ColorThemeOption {
  const value = appearance === 'light' ? settings.lightColorTheme : settings.darkColorTheme
  const options = appearance === 'light' ? LIGHT_COLOR_THEME_OPTIONS : DARK_COLOR_THEME_OPTIONS
  return options.find((option) => option.value === value) ?? options[0]
}

function applyAppearance(settings: AppearanceSettings) {
  const root = document.documentElement
  const resolvedTheme = resolveTheme(settings.theme)
  const colorTheme = resolveColorTheme(settings, resolvedTheme)
  root.dataset.theme = resolvedTheme
  root.dataset.colorTheme = colorTheme.value
  if (colorTheme.palette === 'falcon') {
    delete root.dataset.palette
  } else {
    root.dataset.palette = colorTheme.palette
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
