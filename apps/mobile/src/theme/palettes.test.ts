import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  COLOR_THEME_COLORS,
  COLOR_THEME_OPTIONS,
  DARK_COLOR_THEME_OPTIONS,
  LIGHT_COLOR_THEME_OPTIONS,
  colorThemeSwatchColors,
  normalizeAppearance,
  type ColorThemeOption,
} from './appearance'
import { darkColors } from './tokens'

/**
 * The mobile palettes mirror packages/ui/src/styles.css by hand, so the two
 * drift silently unless something checks. These tests pin every palette to the
 * web token block it claims to mirror, and to the same key shape as the
 * default theme — a missing key surfaces as an undefined color at runtime.
 */
const STYLES = readFileSync(
  resolve(process.cwd(), '../../packages/ui/src/styles.css'),
  'utf8',
)

function tokensFor(selector: string): Record<string, string> {
  const start = STYLES.indexOf(`${selector} {`)
  if (start === -1) return {}
  const block = STYLES.slice(start, STYLES.indexOf('}', start))
  const tokens: Record<string, string> = {}
  for (const [, name, value] of block.matchAll(/(--fd-[\w-]+):\s*([^;]+);/g)) {
    tokens[name] = value.trim()
  }
  return tokens
}

function selectorFor(option: ColorThemeOption) {
  if (option.palette === 'falcon') {
    return option.appearance === 'light' ? ':root[data-theme="light"]' : ':root'
  }
  const paletteSelector = `:root[data-palette="${option.palette}"]`
  return option.appearance === 'light'
    ? `${paletteSelector}[data-theme="light"]`
    : paletteSelector
}

function keyShape(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value)
    .flatMap(([key, child]) => keyShape(child, prefix ? `${prefix}.${key}` : key))
    .sort()
}

describe('mobile color palettes', () => {
  it('backs every theme option with one matching color set', () => {
    expect(Object.keys(COLOR_THEME_COLORS).sort()).toEqual(
      COLOR_THEME_OPTIONS.map((option) => option.value).sort(),
    )
  })

  it('keeps every color theme the same shape as the default theme', () => {
    const expected = keyShape(darkColors)
    for (const [colorTheme, colors] of Object.entries(COLOR_THEME_COLORS)) {
      expect(keyShape(colors), colorTheme).toEqual(expected)
    }
  })

  it('mirrors the web tokens for surfaces and accents', () => {
    for (const option of COLOR_THEME_OPTIONS) {
      const tokens = tokensFor(selectorFor(option))
      const colors = COLOR_THEME_COLORS[option.value]
      expect(
        { theme: option.value, ...colors.surface, fg: colors.fg.primary, accent: colors.accent.default },
      ).toEqual({
        theme: option.value,
        0: tokens['--fd-bg-0'],
        1: tokens['--fd-bg-1'],
        2: tokens['--fd-bg-2'],
        3: tokens['--fd-bg-3'],
        4: tokens['--fd-bg-4'],
        fg: tokens['--fd-fg-0'],
        accent: tokens['--fd-accent'],
      })
    }
  })

  it('draws swatches from the color theme they advertise', () => {
    for (const option of COLOR_THEME_OPTIONS) {
      const colors = COLOR_THEME_COLORS[option.value]
      expect(colorThemeSwatchColors(option.value)).toEqual({
        bg: colors.surface[1],
        surface: colors.surface[2],
        fg: colors.fg.primary,
        accent: colors.accent.default,
      })
    }
  })

  it('keeps Matrix dark-only', () => {
    expect(DARK_COLOR_THEME_OPTIONS.some((option) => option.value === 'matrix')).toBe(true)
    expect(LIGHT_COLOR_THEME_OPTIONS.some((option) => option.palette === 'matrix')).toBe(false)
  })

  it('migrates a legacy palette into independent light and dark preferences', () => {
    expect(normalizeAppearance({ themeMode: 'system', palette: 'tokyo-night' })).toMatchObject({
      themeMode: 'system',
      lightColorTheme: 'tokyo-night-light',
      darkColorTheme: 'tokyo-night',
    })
  })
})
