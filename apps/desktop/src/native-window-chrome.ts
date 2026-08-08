import { getAppearance, subscribeAppearance } from '@falcondeck/ui'

import { isTauriDesktop } from './api'

/* ================================================================
   Native window chrome sync.

   macOS — not the web content — draws the window's rounded corner
   mask and the hairline highlight along the top of the frame. Both
   are painted from the NSWindow's background color and appearance,
   and Tauri leaves those at AppKit's defaults: a light-gray
   `windowBackgroundColor` under the Aqua appearance. Against a dark
   theme that reads as a pale fringe hugging the corner arcs (the
   antialiased edge blends content with the window behind it) plus a
   near-white 1px line across the top.

   So push the resolved canvas color and theme down to the NSWindow
   whenever appearance changes. The color is read back from the
   painted `<body>` background rather than the palette tables, so it
   tracks any theme/palette without duplicating token values.
   ================================================================ */

type Rgba = [number, number, number, number]

/** Parse a computed `rgb()`/`rgba()` string into 0-255 channels. */
function parseComputedColor(value: string): Rgba | null {
  const channels = value.match(/[\d.]+/g)
  if (!channels || channels.length < 3) return null
  const [r, g, b, a] = channels.map(Number)
  if (![r, g, b].every(Number.isFinite)) return null
  const alpha = a === undefined || !Number.isFinite(a) ? 1 : a
  // No CSS yet (transparent canvas) — nothing meaningful to mirror.
  if (alpha === 0) return null
  return [Math.round(r), Math.round(g), Math.round(b), Math.round(alpha * 255)]
}

function readCanvasColor(): Rgba | null {
  return parseComputedColor(getComputedStyle(document.body).backgroundColor)
}

/**
 * The appearance to pin the NSWindow to, or `null` to follow the OS.
 *
 * "System" must stay `null`: pinning an explicit NSAppearance also pins the
 * webview's `prefers-color-scheme`, which is how the resolved theme is read
 * back — pin it and the app stops noticing OS appearance changes.
 */
function readNativeTheme(): 'light' | 'dark' | null {
  const { theme } = getAppearance()
  return theme === 'system' ? null : theme
}

/**
 * Mirror the web canvas color and resolved theme onto the native window so
 * macOS renders the frame in the app's own colors. No-op outside Tauri.
 */
export function initNativeWindowChrome() {
  if (!isTauriDesktop()) return

  let lastColor: string | null = null
  let lastTheme: string | null = null

  const sync = () => {
    const color = readCanvasColor()
    const theme = readNativeTheme()
    const colorKey = color && color.join(',')
    const themeKey = theme ?? 'system'
    if (colorKey === lastColor && themeKey === lastTheme) return

    void import('@tauri-apps/api/window')
      .then(async ({ getCurrentWindow }) => {
        const win = getCurrentWindow()
        if (color && colorKey !== lastColor) {
          lastColor = colorKey
          await win.setBackgroundColor(color)
        }
        if (themeKey !== lastTheme) {
          lastTheme = themeKey
          // Also drives NSApp's appearance, so native menus, dialogs and
          // scrollbars follow the in-app theme instead of the OS setting.
          await win.setTheme(theme)
        }
      })
      .catch(() => {})
  }

  // Wait for first paint so the canvas background is resolved; the static
  // `backgroundColor` in tauri.conf.json covers the frames before that.
  requestAnimationFrame(sync)

  // Covers theme, palette, and OS-appearance changes alike — the store
  // notifies after the document has been restyled.
  subscribeAppearance(sync)
}
