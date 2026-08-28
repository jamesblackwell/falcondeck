import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { extensionFrontends } from '../../scripts/vite-extension-frontends.mjs'

// Framework, markdown rendering, and session crypto are stable vendors whose
// module paths change far less often than app code. Pinning them into named
// chunks keeps them individually cacheable instead of inflating the eager
// entry hash on every release. Mermaid/Shiki are already lazy (dynamic
// imports), so they deliberately stay untouched.
// Vite 8 ships Rolldown: use advancedChunks rather than rollup manualChunks.
const vendorChunkGroups = [
  {
    name: 'vendor-react',
    test: /[\\/]node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/,
  },
  {
    name: 'vendor-markdown',
    // Matches the whole unified ecosystem that react-markdown pulls in
    // (remark*/rehype*/micromark*/mdast*/hast*/unist*/vfile, ...).
    test: /[\\/]node_modules[\\/][^\\/]*(markdown|remark|rehype|micromark|mdast|hast|unist|unified|vfile)/,
  },
  {
    name: 'vendor-crypto',
    test: /[\\/]node_modules[\\/](@noble[\\/][^\\/]+|tweetnacl)[\\/]/,
  },
]

export default defineConfig({
  plugins: [extensionFrontends(), react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 4174,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      output: {
        advancedChunks: {
          groups: vendorChunkGroups,
        },
      },
    },
  },
})
