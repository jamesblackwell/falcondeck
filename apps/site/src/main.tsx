import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'

import './styles.css'
import App from './App'

const root = document.getElementById('root')!
const app = (
  <StrictMode>
    <App />
  </StrictMode>
)

const path = window.location.pathname.replace(/\/+$/, '') || '/'
// Legacy pairing links can land at /?code=…; those need the pairing screen.
if (root.dataset.prerenderPath === path && !new URLSearchParams(window.location.search).get('code')?.trim()) {
  hydrateRoot(root, app)
} else {
  createRoot(root).render(app)
}
