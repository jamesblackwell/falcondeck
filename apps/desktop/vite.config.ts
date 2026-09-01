import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { extensionFrontends } from '../../scripts/vite-extension-frontends.mjs'

// https://vite.dev/config/
export default defineConfig({
  plugins: [extensionFrontends(), react(), tailwindcss()],
  build: {
    // Shiki language grammars and Mermaid/Langium are lazy-loaded. Their raw
    // generated modules can exceed Vite's 500 KB default even though the two
    // largest payloads are currently only about 61 KB and 143 KB gzipped.
    chunkSizeWarningLimit: 850,
    rollupOptions: {
      // The detached Activity window is a second Tauri window, so its entry has
      // to ship in the bundle Tauri serves. (The *-qa.html fixtures stay
      // dev-only on purpose.)
      input: {
        main: 'index.html',
        activity: 'activity-window.html',
        dictation: 'dictation-window.html',
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  preview: {
    port: 1420,
    strictPort: true,
  },
})
