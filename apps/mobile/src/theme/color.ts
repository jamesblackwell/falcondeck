/**
 * The same colour at a different opacity.
 *
 * Gradients and glass tints fade a palette colour into nothing; fading into
 * `transparent` instead interpolates through transparent *black*, which leaves
 * a grey band across light themes. Accepts `#rgb`, `#rrggbb`, `#rrggbbaa`,
 * `rgb()` and `rgba()`; anything else is returned unchanged.
 */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha))
  const value = color.trim()

  if (value.startsWith('#')) {
    let hex = value.slice(1)
    if (hex.length === 3 || hex.length === 4) {
      hex = hex
        .slice(0, 3)
        .split('')
        .map((digit) => digit + digit)
        .join('')
    }
    if (hex.length !== 6 && hex.length !== 8) return color
    const r = Number.parseInt(hex.slice(0, 2), 16)
    const g = Number.parseInt(hex.slice(2, 4), 16)
    const b = Number.parseInt(hex.slice(4, 6), 16)
    if ([r, g, b].some(Number.isNaN)) return color
    return `rgba(${r}, ${g}, ${b}, ${a})`
  }

  const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*[\d.]+)?\s*\)$/i.exec(value)
  if (match) return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${a})`
  return color
}

/**
 * An opaque fill that looks like `tint` laid over `base`: the base colour
 * with the tint painted on top as a flat gradient. Lets a translucent status
 * tint float over scrolling content without the content showing through.
 */
export function layeredFill(base: string, tint: string) {
  return {
    backgroundColor: base,
    experimental_backgroundImage: `linear-gradient(${tint}, ${tint})`,
  } as const
}
