import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initAppearance } from '@falcondeck/ui'
import './index.css'
import App from './App.tsx'
import { isTauriDesktop } from './api'
import { initNativeWindowChrome } from './native-window-chrome'

// Theme + font preferences must land on <html> before first paint.
initAppearance()

// Keep the native window frame (corner mask, top hairline) in the app's colors.
initNativeWindowChrome()

// Cmd+/- zoom support (persisted across sessions)
const ZOOM_KEY = 'fd-zoom-level'
const ZOOM_STEP = 0.05
const ZOOM_MIN = 0.7
const ZOOM_MAX = 1.5

/*
 * Prefer the webview's native page zoom over CSS `zoom` on <html>. CSS zoom
 * scales the root box but WebKit keeps the initial containing block at the
 * unzoomed viewport size until the next layout pass, so zooming out leaves a
 * band of bare window background across the bottom until something else
 * forces a relayout. Native zoom resizes the layout viewport itself, so
 * `100%`/`vh` heights and `window.innerHeight` all stay honest.
 */
function applyZoom(level: number) {
  localStorage.setItem(ZOOM_KEY, String(level))

  if (!isTauriDesktop()) {
    document.documentElement.style.zoom = String(level)
    return
  }

  void import('@tauri-apps/api/webview')
    .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(level))
    .catch(() => {
      // No webview-zoom permission (or an older shell): fall back to CSS.
      document.documentElement.style.zoom = String(level)
    })
}

function getZoom() {
  const stored = parseFloat(localStorage.getItem(ZOOM_KEY) ?? '1')
  return Number.isFinite(stored) ? stored : 1
}

applyZoom(getZoom())

document.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey)) return
  if (event.key === '=' || event.key === '+') {
    event.preventDefault()
    applyZoom(Math.min(getZoom() + ZOOM_STEP, ZOOM_MAX))
  } else if (event.key === '-') {
    event.preventDefault()
    applyZoom(Math.max(getZoom() - ZOOM_STEP, ZOOM_MIN))
  } else if (event.key === '0') {
    event.preventDefault()
    applyZoom(1)
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
