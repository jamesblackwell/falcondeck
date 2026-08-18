import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { extensionFrontends } from '../../scripts/vite-extension-frontends.mjs'

export default defineConfig({
  plugins: [extensionFrontends(), react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 4174,
    strictPort: true,
  },
})
