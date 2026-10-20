import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { build as esbuild } from 'esbuild';
const source = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(source, '../ExtensionResources');
await build({
  configFile: false, root: source, define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), tailwindcss()],
  build: {
    outDir, emptyOutDir: true, target: 'safari16',
    lib: { entry: resolve(source, 'host.tsx'), name: 'FalconDeckExtensionHost', formats: ['iife'], fileName: () => 'host.js', cssFileName: 'host' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
await writeFile(resolve(outDir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><link rel="stylesheet" href="host.css"></head><body><div id="root"></div><script src="host.js"></script></body></html>`);
// Keep Swift's eligibility check aligned with actual compiled registrations,
// including tool IDs and their extension-owned detail titles.
const manifestBuild = await esbuild({
  entryPoints: [resolve(source, 'registry.ts')], bundle: true, write: false,
  platform: 'node', format: 'esm', target: 'node20',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
});
const { registrationManifest } = await import(`data:text/javascript;base64,${Buffer.from(manifestBuild.outputFiles[0].text).toString('base64')}`);
await writeFile(resolve(outDir, 'registrations.json'), JSON.stringify(registrationManifest));
