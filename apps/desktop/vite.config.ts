import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      // The detached Activity window is a second Tauri window, so its entry has
      // to ship in the bundle Tauri serves. (The *-qa.html fixtures stay
      // dev-only on purpose.)
      input: {
        main: 'index.html',
        activity: 'activity-window.html',
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
