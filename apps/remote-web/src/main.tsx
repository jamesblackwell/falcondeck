import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App'
import './styles.css'

if (window.matchMedia('(pointer: coarse)').matches) {
  const preventZoom = (event: Event) => {
    event.preventDefault()
  }
  const preventPinch = (event: TouchEvent) => {
    if (event.touches.length > 1) {
      event.preventDefault()
    }
  }
  const preventWheelZoom = (event: WheelEvent) => {
    if (event.ctrlKey) {
      event.preventDefault()
    }
  }

  document.addEventListener('gesturestart', preventZoom, { passive: false })
  document.addEventListener('gesturechange', preventZoom, { passive: false })
  document.addEventListener('gestureend', preventZoom, { passive: false })
  document.addEventListener('touchmove', preventPinch, { passive: false })
  document.addEventListener('wheel', preventWheelZoom, { passive: false })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
