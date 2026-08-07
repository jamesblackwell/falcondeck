/**
 * FalconDeck design tokens for React Native.
 * Mirrors packages/ui/src/styles.css with mobile-appropriate sizing.
 *
 * Colors, spacing, radii, and shadows are 1:1 with the web design system.
 * Font sizes are scaled up slightly for mobile readability (native text
 * renders smaller than web at the same px value).
 */
import { Platform } from 'react-native'

export const darkColors = {
  // Background depth scale
  surface: {
    0: '#09090b',
    1: '#111113',
    2: '#1a1a1f',
    3: '#232329',
    4: '#2c2c34',
  },

  // Foreground / text contrast scale. tertiary and muted carry real copy, so
  // they clear WCAG AA (≥4.5:1) on surface 1; faint is decorative-only.
  fg: {
    primary: '#f4f4f6',
    secondary: '#c4c4cc',
    tertiary: '#9d9da8',
    muted: '#84848f',
    faint: '#6d6d78',
  },

  // Borders (solid approximations of rgba on dark bg)
  border: {
    subtle: '#1a1a1f',
    default: '#232329',
    emphasis: '#2c2c34',
    strong: '#3a3a44',
  },

  // Accent — Emerald
  accent: {
    default: '#34d399',
    muted: 'rgba(52, 211, 153, 0.14)',
    strong: '#6ee7b7',
    dim: 'rgba(52, 211, 153, 0.07)',
  },

  // Semantic
  success: { default: '#34d399', muted: 'rgba(52, 211, 153, 0.12)' },
  warning: { default: '#fbbf24', muted: 'rgba(251, 191, 36, 0.12)' },
  danger: { default: '#f87171', muted: 'rgba(248, 113, 113, 0.12)' },
  info: { default: '#60a5fa', muted: 'rgba(96, 165, 250, 0.12)' },

  // Diff
  diff: {
    added: 'rgba(52, 211, 153, 0.12)',
    removed: 'rgba(248, 113, 113, 0.12)',
    addedText: '#6ee7b7',
    removedText: '#fca5a5',
  },

  // Overlay / scrim — mirrors --fd-overlay / --fd-overlay-strong on web.
  // `overlay` backs centered dialogs and option sheets; `overlayStrong` backs
  // full-screen drawers and is always paired with a blur.
  overlay: 'rgba(0, 0, 0, 0.45)',
  overlayStrong: 'rgba(9, 9, 11, 0.8)',

  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

// Light palette — mirrors the light theme in packages/ui/src/styles.css.
// Same shape as darkColors so unistyles themes stay interchangeable.
export const lightColors: typeof darkColors = {
  surface: {
    0: '#f4f4f5',
    1: '#fbfbfc',
    2: '#ffffff',
    3: '#ececef',
    4: '#e1e1e5',
  },

  fg: {
    primary: '#17171c',
    secondary: '#3c3c44',
    tertiary: '#5a5a64',
    muted: '#71717c',
    faint: '#8f8f9a',
  },

  // Solid approximations of rgba(17,17,20,…) over the light surfaces
  border: {
    subtle: '#ebebec',
    default: '#e3e3e5',
    emphasis: '#d8d8da',
    strong: '#c8c8cb',
  },

  // Emerald deepens on light surfaces to keep contrast
  accent: {
    default: '#059669',
    muted: 'rgba(5, 150, 105, 0.12)',
    strong: '#047857',
    dim: 'rgba(5, 150, 105, 0.06)',
  },

  success: { default: '#059669', muted: 'rgba(5, 150, 105, 0.10)' },
  warning: { default: '#b45309', muted: 'rgba(180, 83, 9, 0.10)' },
  danger: { default: '#dc2626', muted: 'rgba(220, 38, 38, 0.08)' },
  info: { default: '#2563eb', muted: 'rgba(37, 99, 235, 0.08)' },

  diff: {
    added: 'rgba(5, 150, 105, 0.10)',
    removed: 'rgba(220, 38, 38, 0.08)',
    addedText: '#047857',
    removedText: '#b91c1c',
  },

  overlay: 'rgba(23, 23, 28, 0.32)',
  overlayStrong: 'rgba(250, 250, 251, 0.85)',

  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

// --- Gruvbox-inspired palettes — mirror packages/ui/src/styles.css ---

export const gruvboxDarkColors: typeof darkColors = {
  surface: { 0: '#1d2021', 1: '#282828', 2: '#32302f', 3: '#3c3836', 4: '#504945' },
  fg: {
    primary: '#fbf1c7',
    secondary: '#ebdbb2',
    tertiary: '#c8b998',
    muted: '#b0a184',
    faint: '#8f8371',
  },
  border: { subtle: '#32302f', default: '#3c3836', emphasis: '#504945', strong: '#665c54' },
  accent: {
    default: '#8ec07c',
    muted: 'rgba(142, 192, 124, 0.14)',
    strong: '#a5d18f',
    dim: 'rgba(142, 192, 124, 0.07)',
  },
  success: { default: '#b8bb26', muted: 'rgba(184, 187, 38, 0.12)' },
  warning: { default: '#fabd2f', muted: 'rgba(250, 189, 47, 0.12)' },
  danger: { default: '#fb4934', muted: 'rgba(251, 73, 52, 0.12)' },
  info: { default: '#83a598', muted: 'rgba(131, 165, 152, 0.12)' },
  diff: {
    added: 'rgba(184, 187, 38, 0.12)',
    removed: 'rgba(251, 73, 52, 0.12)',
    addedText: '#b8bb26',
    removedText: '#fb4934',
  },
  overlay: 'rgba(0, 0, 0, 0.45)',
  overlayStrong: 'rgba(29, 32, 33, 0.8)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

export const gruvboxLightColors: typeof darkColors = {
  surface: { 0: '#f2e5bc', 1: '#f9efc6', 2: '#fbf1c7', 3: '#e7d8ac', 4: '#d5c4a1' },
  fg: {
    primary: '#282828',
    secondary: '#3c3836',
    tertiary: '#504945',
    muted: '#665c54',
    faint: '#857a6e',
  },
  border: { subtle: '#e5d7ae', default: '#dccfa6', emphasis: '#cfc19a', strong: '#bcae89' },
  accent: {
    default: '#427b58',
    muted: 'rgba(66, 123, 88, 0.14)',
    strong: '#356449',
    dim: 'rgba(66, 123, 88, 0.07)',
  },
  success: { default: '#79740e', muted: 'rgba(121, 116, 14, 0.12)' },
  warning: { default: '#b57614', muted: 'rgba(181, 118, 20, 0.12)' },
  danger: { default: '#cc241d', muted: 'rgba(204, 36, 29, 0.10)' },
  info: { default: '#076678', muted: 'rgba(7, 102, 120, 0.10)' },
  diff: {
    added: 'rgba(121, 116, 14, 0.12)',
    removed: 'rgba(204, 36, 29, 0.10)',
    addedText: '#79740e',
    removedText: '#9d0006',
  },
  overlay: 'rgba(40, 40, 40, 0.32)',
  overlayStrong: 'rgba(251, 241, 199, 0.85)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

// --- Tokyo Night-inspired palettes — mirror packages/ui/src/styles.css ---

export const tokyoNightDarkColors: typeof darkColors = {
  surface: { 0: '#16161e', 1: '#1a1b26', 2: '#24283b', 3: '#292e42', 4: '#3b4261' },
  fg: {
    primary: '#c0caf5',
    secondary: '#a9b1d6',
    tertiary: '#939bc4',
    muted: '#8189af',
    faint: '#666d92',
  },
  border: { subtle: '#24283b', default: '#292e42', emphasis: '#3b4261', strong: '#4a5378' },
  accent: {
    default: '#7aa2f7',
    muted: 'rgba(122, 162, 247, 0.15)',
    strong: '#94b6fa',
    dim: 'rgba(122, 162, 247, 0.07)',
  },
  success: { default: '#9ece6a', muted: 'rgba(158, 206, 106, 0.12)' },
  warning: { default: '#e0af68', muted: 'rgba(224, 175, 104, 0.12)' },
  danger: { default: '#f7768e', muted: 'rgba(247, 118, 142, 0.12)' },
  info: { default: '#7dcfff', muted: 'rgba(125, 207, 255, 0.12)' },
  diff: {
    added: 'rgba(158, 206, 106, 0.12)',
    removed: 'rgba(247, 118, 142, 0.12)',
    addedText: '#9ece6a',
    removedText: '#f7768e',
  },
  overlay: 'rgba(0, 0, 0, 0.45)',
  overlayStrong: 'rgba(22, 22, 30, 0.8)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

export const tokyoNightLightColors: typeof darkColors = {
  surface: { 0: '#d6d8e3', 1: '#e4e6ee', 2: '#eff1f7', 3: '#ced2e0', 4: '#bfc4d6' },
  fg: {
    primary: '#2e3350',
    secondary: '#40456b',
    tertiary: '#545a80',
    muted: '#616894',
    faint: '#7d84a8',
  },
  border: { subtle: '#d4d7e2', default: '#c9cdda', emphasis: '#bbc0d0', strong: '#a6acc1' },
  accent: {
    default: '#2e7de9',
    muted: 'rgba(46, 125, 233, 0.13)',
    strong: '#1a63cf',
    dim: 'rgba(46, 125, 233, 0.06)',
  },
  success: { default: '#587539', muted: 'rgba(88, 117, 57, 0.12)' },
  warning: { default: '#8f5e15', muted: 'rgba(143, 94, 21, 0.12)' },
  danger: { default: '#c53963', muted: 'rgba(197, 57, 99, 0.10)' },
  info: { default: '#007197', muted: 'rgba(0, 113, 151, 0.10)' },
  diff: {
    added: 'rgba(88, 117, 57, 0.12)',
    removed: 'rgba(197, 57, 99, 0.10)',
    addedText: '#587539',
    removedText: '#c53963',
  },
  overlay: 'rgba(46, 51, 80, 0.32)',
  overlayStrong: 'rgba(228, 230, 238, 0.85)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

// Back-compat alias — prefer reading colors from the active unistyles theme
// (`useUnistyles().theme.colors`) so light mode is respected.
export const colors = darkColors

export const spacing = {
  0: 0,
  px: 1,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const

export const radius = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  '2xl': 20,
  full: 999,
} as const

// Mobile font sizes — scaled from the web design system for native readability
export const fontSize = {
  '2xs': 10,
  xs: 12,
  sm: 14,
  base: 16,
  md: 17,
  lg: 19,
  xl: 22,
  '2xl': 26,
  '3xl': 32,
} as const

export const lineHeight = {
  tight: 1.25,
  normal: 1.5,
  relaxed: 1.65,
} as const

export const fontFamily = {
  sans: 'Inter',
  mono: Platform.select({
    ios: 'SF Mono',
    default: 'JetBrains Mono',
  }) as string,
} as const

export const shadow = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 6,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.4,
    shadowRadius: 40,
    elevation: 12,
  },
}

export const duration = {
  fast: 100,
  normal: 150,
  slow: 250,
} as const

export const iconSize = {
  // xs is the dense inline size used inside list rows and disclosure headers.
  xs: 14,
  sm: 16,
  md: 20,
  lg: 24,
  xl: 32,
} as const

// Minimum touch target per Apple HIG / Material. Pair with hitSlop when the
// painted control is smaller than this.
export const minTouchTarget = 44
