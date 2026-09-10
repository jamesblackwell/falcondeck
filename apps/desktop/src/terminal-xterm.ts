/** Prefetch xterm and its addons so the first Cmd+J does not wait on the network. */
let prefetchPromise: Promise<void> | null = null

export function prefetchTerminalRuntime(): Promise<void> {
  if (!prefetchPromise) {
    prefetchPromise = Promise.allSettled([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-webgl'),
      import('@xterm/addon-search'),
      import('@xterm/addon-web-links'),
      import('@xterm/addon-clipboard'),
      import('@xterm/addon-unicode11'),
    ]).then(() => undefined)
  }
  return prefetchPromise
}
