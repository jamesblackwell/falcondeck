/**
 * FalconDeck design tokens for React Native.
 * Mirrors packages/ui/src/styles.css with mobile-appropriate sizing.
 *
 * Colors, spacing, radii, and shadows are 1:1 with the web design system.
 * Font sizes are scaled up slightly for mobile readability (native text
 * renders smaller than web at the same px value).
 */
import { Platform } from 'react-native'

export const colors = {
  // Background depth scale
  surface: {
    0: '#09090b',
    1: '#111113',
    2: '#1a1a1f',
    3: '#232329',
    4: '#2c2c34',
  },

  // Foreground / text contrast scale
  fg: {
    primary: '#f4f4f6',
    secondary: '#c4c4cc',
    tertiary: '#8e8e99',
    muted: '#62626d',
    faint: '#42424a',
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

  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
} as const

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
} as const

export const duration = {
  fast: 100,
  normal: 150,
  slow: 250,
} as const

export const iconSize = {
  sm: 16,
  md: 20,
  lg: 24,
  xl: 32,
} as const
