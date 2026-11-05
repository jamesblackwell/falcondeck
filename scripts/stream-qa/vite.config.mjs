// Production build of the streaming fixture: dev-mode React costs 5-10x more,
// so frame numbers from a vite dev server are meaningless.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { extensionFrontends } from '../vite-extension-frontends.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.join(here, '../../apps/desktop'),
  plugins: [extensionFrontends(), react(), tailwindcss()],
  cacheDir: process.env.STREAM_QA_OUT
    ? path.join(process.env.STREAM_QA_OUT, '.vite')
    : undefined,
  build: {
    outDir: process.env.STREAM_QA_OUT ?? '/tmp/fd-stream-qa-build',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { stream: path.join(here, '../../apps/desktop/stream-qa.html') } },
  },
})
