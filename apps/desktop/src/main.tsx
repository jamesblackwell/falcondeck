import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Cmd+/- zoom support (persisted across sessions)
const ZOOM_KEY = 'fd-zoom-level'
const ZOOM_STEP = 0.05
const ZOOM_MIN = 0.7
const ZOOM_MAX = 1.5

function applyZoom(level: number) {
  document.documentElement.style.zoom = String(level)
  localStorage.setItem(ZOOM_KEY, String(level))
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
