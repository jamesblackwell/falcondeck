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
export type SansFontSetting =
  | 'geist'
  | 'lexend'
  | 'inter'
  | 'system'
  | 'rounded'
  | 'avenir'
  | 'helvetica'
  | 'new-york'
  | 'serif'
  | 'custom'
export type MonoFontSetting =
  | 'geist-mono'
  | 'system-mono'
  | 'jetbrains-mono'
  | 'fira-code'
  | 'cascadia'
  | 'menlo'
  | 'custom'
/** Chat can follow the interface font or pick its own face. */
export type ChatFontSetting = 'match' | SansFontSetting

export type AppearanceSettings = {
  theme: ThemeSetting
  lightColorTheme: LightColorThemeSetting
  darkColorTheme: DarkColorThemeSetting
  sansFont: SansFontSetting
  /** Family name typed by the user; used when sansFont === 'custom'. */
  sansFontCustom: string
  chatFont: ChatFontSetting
  chatFontCustom: string
  monoFont: MonoFontSetting
  monoFontCustom: string
  /** Multiplier applied to the --fd-text-* scale. */
  fontScale: number
  /** Per-surface multipliers layered on top of fontScale. 1 = no change. */
  sidebarScale: number
  chatScale: number
  codeScale: number
  /** Base font weights per surface; 0 = leave the theme default alone. */
  uiWeight: number
  sidebarWeight: number
  chatWeight: number
  codeWeight: number
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: 'system',
  lightColorTheme: 'falcon-light',
  darkColorTheme: 'falcon-dark',
  sansFont: 'geist',
  sansFontCustom: '',
  chatFont: 'match',
  chatFontCustom: '',
  monoFont: 'geist-mono',
  monoFontCustom: '',
  fontScale: 1.05,
  sidebarScale: 1,
  chatScale: 1,
  codeScale: 1,
  uiWeight: 0,
  sidebarWeight: 0,
  chatWeight: 0,
  codeWeight: 0,
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

export type FontOption<V extends string> = {
  value: V
  label: string
  stack: string
  /** Shown as the row's second line in the picker. */
  description: string
}

/**
 * Geist and Lexend ship with the app; everything else resolves against fonts
 * installed on this machine and falls back gracefully when absent. 'custom'
 * is a sentinel — the stack comes from the typed family name at apply time.
 */
export const SANS_FONT_OPTIONS: Array<FontOption<SansFontSetting>> = [
  {
    value: 'geist',
    label: 'Geist',
    description: 'The FalconDeck default. Bundled.',
    stack: '"Geist", "Inter", "SF Pro Display", "Segoe UI", system-ui, sans-serif',
  },
  {
    value: 'lexend',
    label: 'Lexend',
    description: 'Designed for reading proficiency. Bundled.',
    stack: '"Lexend", "Geist", system-ui, sans-serif',
  },
  {
    value: 'inter',
    label: 'Inter',
    description: 'The screen-UI workhorse. Uses your installed copy.',
    stack: '"Inter", "Geist", system-ui, sans-serif',
  },
  {
    value: 'system',
    label: 'System',
    description: 'SF Pro — whatever this device considers native.',
    stack: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif',
  },
  {
    value: 'rounded',
    label: 'SF Rounded',
    description: 'The system face with rounded terminals.',
    stack: 'ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif',
  },
  {
    value: 'avenir',
    label: 'Avenir Next',
    description: 'Geometric humanist classic, ships with macOS.',
    stack: '"Avenir Next", Avenir, "Segoe UI", system-ui, sans-serif',
  },
  {
    value: 'helvetica',
    label: 'Helvetica Neue',
    description: 'The grotesque standard, ships with macOS.',
    stack: '"Helvetica Neue", Helvetica, Arial, system-ui, sans-serif',
  },
  {
    value: 'new-york',
    label: 'New York',
    description: 'The system serif, tuned for screens.',
    stack: 'ui-serif, "New York", Georgia, serif',
  },
  {
    value: 'serif',
    label: 'Book Serif',
    description: 'Iowan / Palatino — an old-style reading face.',
    stack: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  },
  {
    value: 'custom',
    label: 'Custom…',
    description: 'Type the name of any font installed on this Mac.',
    stack: 'var(--fd-font-sans)',
  },
]

export const MONO_FONT_OPTIONS: Array<FontOption<MonoFontSetting>> = [
  {
    value: 'geist-mono',
    label: 'Geist Mono',
    description: 'The FalconDeck default. Bundled.',
    stack: '"Geist Mono", "SF Mono", "JetBrains Mono", "Cascadia Code", ui-monospace, monospace',
  },
  {
    value: 'system-mono',
    label: 'System',
    description: 'SF Mono / Menlo — the native terminal face.',
    stack: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  },
  {
    value: 'jetbrains-mono',
    label: 'JetBrains Mono',
    description: 'Tall x-height, ligatures. Uses your installed copy.',
    stack: '"JetBrains Mono", "Geist Mono", ui-monospace, monospace',
  },
  {
    value: 'fira-code',
    label: 'Fira Code',
    description: 'Ligature pioneer. Uses your installed copy.',
    stack: '"Fira Code", "Geist Mono", ui-monospace, monospace',
  },
  {
    value: 'cascadia',
    label: 'Cascadia Code',
    description: 'Microsoft’s terminal face. Uses your installed copy.',
    stack: '"Cascadia Code", "Geist Mono", ui-monospace, monospace',
  },
  {
    value: 'menlo',
    label: 'Menlo',
    description: 'The pre-SF Mono macOS classic.',
    stack: 'Menlo, Monaco, ui-monospace, monospace',
  },
  {
    value: 'custom',
    label: 'Custom…',
    description: 'Type the name of any monospace font installed here.',
    stack: 'var(--fd-font-mono)',
  },
]

export const FONT_SCALE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0.95, label: 'Small' },
  { value: 1.05, label: 'Default' },
  { value: 1.15, label: 'Large' },
  { value: 1.25, label: 'Extra large' },
]

/** Per-surface size multipliers, layered on the global text size. */
export const SURFACE_SCALE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0.9, label: '90%' },
  { value: 0.95, label: '95%' },
  { value: 1, label: '100%' },
  { value: 1.05, label: '105%' },
  { value: 1.1, label: '110%' },
  { value: 1.15, label: '115%' },
]

/** Base-weight overrides. Headings and labels keep their heavier weights. */
export const FONT_WEIGHT_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'Default' },
  { value: 300, label: 'Light' },
  { value: 350, label: 'Book' },
  { value: 400, label: 'Regular' },
  { value: 450, label: 'Text' },
  { value: 500, label: 'Medium' },
]

/**
 * A typed family name travels into a CSS font-family value, so it is reduced
 * to characters that can never terminate the declaration or smuggle in a url().
 */
export function sanitizeFontName(name: unknown): string {
  if (typeof name !== 'string') return ''
  return name.replace(/[^\w \-.]/g, '').trim().slice(0, 64)
}

function presetStack<V extends string>(
  options: Array<FontOption<V>>,
  value: V,
): string | null {
  const option = options.find((o) => o.value === value)
  return option && option.value !== 'custom' ? option.stack : null
}

/** The concrete font-family value for a sans choice, or null for the default. */
export function resolveSansStack(
  setting: SansFontSetting,
  customName: string,
): string | null {
  if (setting === 'custom') {
    const name = sanitizeFontName(customName)
    return name ? `"${name}", "Geist", system-ui, sans-serif` : null
  }
  return presetStack(SANS_FONT_OPTIONS, setting)
}

export function resolveMonoStack(
  setting: MonoFontSetting,
  customName: string,
): string | null {
  if (setting === 'custom') {
    const name = sanitizeFontName(customName)
    return name ? `"${name}", "Geist Mono", ui-monospace, monospace` : null
  }
  return presetStack(MONO_FONT_OPTIONS, setting)
}

const STORAGE_KEY = 'fd-appearance'
const DARK_QUERY = '(prefers-color-scheme: dark)'

function normalizeScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.min(1.3, Math.max(0.8, value))
}

function normalizeWeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.min(900, Math.max(100, Math.round(value / 50) * 50))
}

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
    sansFontCustom: sanitizeFontName(raw.sansFontCustom),
    chatFont:
      raw.chatFont === 'match' || SANS_FONT_OPTIONS.some((o) => o.value === raw.chatFont)
        ? (raw.chatFont as ChatFontSetting)
        : 'match',
    chatFontCustom: sanitizeFontName(raw.chatFontCustom),
    monoFont: MONO_FONT_OPTIONS.some((o) => o.value === raw.monoFont)
      ? (raw.monoFont as MonoFontSetting)
      : 'geist-mono',
    monoFontCustom: sanitizeFontName(raw.monoFontCustom),
    fontScale: FONT_SCALE_OPTIONS.some((o) => o.value === raw.fontScale)
      ? (raw.fontScale as number)
      : DEFAULT_APPEARANCE.fontScale,
    sidebarScale: normalizeScale(raw.sidebarScale),
    chatScale: normalizeScale(raw.chatScale),
    codeScale: normalizeScale(raw.codeScale),
    uiWeight: normalizeWeight(raw.uiWeight),
    sidebarWeight: normalizeWeight(raw.sidebarWeight),
    chatWeight: normalizeWeight(raw.chatWeight),
    codeWeight: normalizeWeight(raw.codeWeight),
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

  const setOrRemove = (property: string, value: string | null) => {
    if (value === null) root.style.removeProperty(property)
    else root.style.setProperty(property, value)
  }

  const sansStack = resolveSansStack(settings.sansFont, settings.sansFontCustom)
  setOrRemove('--fd-font-sans', settings.sansFont === 'geist' ? null : sansStack)
  setOrRemove(
    '--fd-font-chat',
    settings.chatFont === 'match'
      ? null
      : resolveSansStack(settings.chatFont, settings.chatFontCustom),
  )
  const monoStack = resolveMonoStack(settings.monoFont, settings.monoFontCustom)
  setOrRemove('--fd-font-mono', settings.monoFont === 'geist-mono' ? null : monoStack)

  root.style.setProperty('--fd-font-scale', String(settings.fontScale))
  setOrRemove('--fd-scale-sidebar', settings.sidebarScale === 1 ? null : String(settings.sidebarScale))
  setOrRemove('--fd-scale-chat', settings.chatScale === 1 ? null : String(settings.chatScale))
  setOrRemove('--fd-scale-code', settings.codeScale === 1 ? null : String(settings.codeScale))
  setOrRemove('--fd-weight-ui', settings.uiWeight === 0 ? null : String(settings.uiWeight))
  setOrRemove('--fd-weight-sidebar', settings.sidebarWeight === 0 ? null : String(settings.sidebarWeight))
  setOrRemove('--fd-weight-chat', settings.chatWeight === 0 ? null : String(settings.chatWeight))
  setOrRemove('--fd-weight-code', settings.codeWeight === 0 ? null : String(settings.codeWeight))
}

/* --- Tiny external store so any component can read/update settings --- */

let current: AppearanceSettings = { ...DEFAULT_APPEARANCE }
/**
 * A theme being tried on — applied to the document but never persisted, so
 * escaping the picker leaves the saved settings untouched.
 */
let preview: Partial<AppearanceSettings> | null = null
let initialized = false
const listeners = new Set<() => void>()

/** Settings as the document currently renders them: saved, plus any preview. */
let effective: AppearanceSettings = current

function recomputeEffective() {
  effective = preview ? normalizeAppearance({ ...current, ...preview }) : current
}

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
  recomputeEffective()
  applyAppearance(effective)

  const media = darkMediaQuery()
  const onSystemChange = () => {
    if (effective.theme === 'system') {
      applyAppearance(effective)
      notify()
    }
  }
  if (typeof media?.addEventListener === 'function') {
    media.addEventListener('change', onSystemChange)
  }
  return current
}

/** What the document is showing — the preview while one is active. */
export function getAppearance(): AppearanceSettings {
  return effective
}

/** What is saved, ignoring any preview. Use for "currently selected" marks. */
export function getPersistedAppearance(): AppearanceSettings {
  return current
}

export function updateAppearance(patch: Partial<AppearanceSettings>) {
  preview = null
  current = normalizeAppearance({ ...current, ...patch })
  recomputeEffective()
  saveAppearance(current)
  applyAppearance(effective)
  notify()
}

/**
 * Apply `patch` to the document without saving it; pass null to drop back to
 * the persisted settings. Lets a picker show the real thing under the cursor
 * and commit only on selection.
 */
export function previewAppearance(patch: Partial<AppearanceSettings> | null) {
  const next = patch && Object.keys(patch).length > 0 ? patch : null
  if (!next && !preview) return
  preview = next
  const previous = effective
  recomputeEffective()
  // Arrowing through a list re-enters this for every row; skipping the
  // no-op writes keeps the document (and Shiki, which re-tokenizes on theme)
  // from churning when neighbouring rows resolve to the same appearance.
  if (previous !== effective && !sameAppearance(previous, effective)) {
    applyAppearance(effective)
    notify()
  }
}

function sameAppearance(a: AppearanceSettings, b: AppearanceSettings): boolean {
  return (Object.keys(DEFAULT_APPEARANCE) as Array<keyof AppearanceSettings>).every(
    (key) => a[key] === b[key],
  )
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

/** Reactive hook over the appearance store, preview included. */
export function useAppearance(): AppearanceSettings {
  return useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance)
}

/** Reactive hook over the saved settings, unaffected by an active preview. */
export function usePersistedAppearance(): AppearanceSettings {
  return useSyncExternalStore(
    subscribeAppearance,
    getPersistedAppearance,
    getPersistedAppearance,
  )
}
