import React from 'react'
import ReactDOM from 'react-dom/client'
import { initAppearance } from '@falcondeck/ui'

import App from './App'
import { RemoteErrorBoundary } from './components/RemoteErrorBoundary'
import './styles.css'

// Theme + font preferences must land on <html> before first paint.
initAppearance()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RemoteErrorBoundary>
      <App />
    </RemoteErrorBoundary>
  </React.StrictMode>,
)
