import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { createServer, defineConfig, type Plugin } from 'vite'

// Publish readable HTML using the same components as the interactive site.
function prerenderPages(): Plugin {
  return {
    name: 'falcondeck-static-pages',
    apply: 'build',
    enforce: 'post',
    async generateBundle(_options, bundle) {
      const index = bundle['index.html']
      if (!index || index.type !== 'asset' || typeof index.source !== 'string') {
        this.error('Expected an HTML entry for the marketing site')
      }
      const template = index.source
      const renderer = await createServer({
        configFile: false,
        root: import.meta.dirname,
        plugins: [react()],
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { middlewareMode: true, hmr: false, watch: null },
        appType: 'custom',
      })
      try {
        const { render } = await renderer.ssrLoadModule('/src/prerender.tsx')
        for (const path of ['/', '/privacy', '/terms']) {
          let html = template.replace(
            '<div id="root"></div>',
            `<div id="root" data-prerender-path="${path}">${render(path)}</div>`,
          )
          if (path !== '/') {
            const title = `${path === '/privacy' ? 'Privacy Policy' : 'Terms of Use'} | FalconDeck`
            html = html.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
              .replace('rel="canonical" href="https://falcondeck.com/"', `rel="canonical" href="https://falcondeck.com${path}"`)
              .replace(/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${title}"`)
              .replace('property="og:url" content="https://falcondeck.com/"', `property="og:url" content="https://falcondeck.com${path}"`)
            this.emitFile({ type: 'asset', fileName: `${path.slice(1)}/index.html`, source: html })
          } else {
            index.source = html
          }
        }
      } finally {
        await renderer.close()
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), prerenderPages()],
  server: {
    host: '0.0.0.0',
    port: 4175,
    strictPort: true,
  },
})
