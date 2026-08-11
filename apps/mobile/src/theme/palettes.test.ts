import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PALETTE_COLORS, PALETTE_OPTIONS, paletteSwatchColors } from './appearance'
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

function selectorsFor(palette: string) {
  return palette === 'falcon'
    ? { dark: ':root', light: ':root[data-theme="light"]' }
    : {
        dark: `:root[data-palette="${palette}"]`,
        light: `:root[data-palette="${palette}"][data-theme="light"]`,
      }
}

function keyShape(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value)
    .flatMap(([key, child]) => keyShape(child, prefix ? `${prefix}.${key}` : key))
    .sort()
}

describe('mobile color palettes', () => {
  it('backs every option with a light and dark color set', () => {
    expect(Object.keys(PALETTE_COLORS).sort()).toEqual(
      PALETTE_OPTIONS.map((option) => option.value).sort(),
    )
  })

  it('keeps every palette the same shape as the default theme', () => {
    const expected = keyShape(darkColors)
    for (const [palette, modes] of Object.entries(PALETTE_COLORS)) {
      expect(keyShape(modes.dark), `${palette} dark`).toEqual(expected)
      expect(keyShape(modes.light), `${palette} light`).toEqual(expected)
    }
  })

  it('mirrors the web tokens for surfaces and accents', () => {
    for (const option of PALETTE_OPTIONS) {
      const selectors = selectorsFor(option.value)
      for (const mode of ['dark', 'light'] as const) {
        // Light blocks only override what changes, so fall back to the dark
        // block the same way the cascade does.
        const tokens = { ...tokensFor(selectors.dark), ...tokensFor(selectors[mode]) }
        const colors = PALETTE_COLORS[option.value][mode]
        expect(
          { palette: option.value, mode, ...colors.surface, fg: colors.fg.primary, accent: colors.accent.default },
        ).toEqual({
          palette: option.value,
          mode,
          0: tokens['--fd-bg-0'],
          1: tokens['--fd-bg-1'],
          2: tokens['--fd-bg-2'],
          3: tokens['--fd-bg-3'],
          4: tokens['--fd-bg-4'],
          fg: tokens['--fd-fg-0'],
          accent: tokens['--fd-accent'],
        })
      }
    }
  })

  it('draws swatches from the palette they advertise', () => {
    for (const option of PALETTE_OPTIONS) {
      for (const mode of ['dark', 'light'] as const) {
        const colors = PALETTE_COLORS[option.value][mode]
        expect(paletteSwatchColors(option.value, mode)).toEqual({
          bg: colors.surface[1],
          surface: colors.surface[2],
          fg: colors.fg.primary,
          accent: colors.accent.default,
        })
      }
    }
  })
})
