declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}

export async function detectApiBaseUrl() {
  const configured = import.meta.env.VITE_FALCONDECK_API_BASE_URL
  if (configured) {
    return configured
  }

  if (window.__TAURI_INTERNALS__) {
    const { invoke } = await import('@tauri-apps/api/core')
    const response = await invoke<{ baseUrl: string }>('ensure_daemon_running')
    return response.baseUrl
  }

  return 'http://127.0.0.1:4123'
}

export function isTauriDesktop() {
  return Boolean(window.__TAURI_INTERNALS__)
}

export async function restartDesktopApp() {
  if (!isTauriDesktop()) {
    throw new Error('Desktop restart is only available in the packaged FalconDeck app.')
  }

  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('restart_app')
}

/** Open, or re-focus, the detached Activity window. Desktop-only. */
export async function openActivityWindow() {
  if (!isTauriDesktop()) {
    throw new Error(
      'A separate Activity window is only available in the FalconDeck desktop app.',
    )
  }

  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('open_activity_window')
}

function isSafeExternalUrl(url: string) {
  const lower = url.toLowerCase()
  return (
    lower.startsWith('https://') ||
    lower.startsWith('http://') ||
    lower.startsWith('mailto:') ||
    lower.startsWith('tel:')
  )
}

export async function openExternalUrl(url: string) {
  if (!isSafeExternalUrl(url)) {
    throw new Error('FalconDeck can only open http, https, mailto, or tel links.')
  }

  if (isTauriDesktop()) {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('open_external_url', { url })
    return
  }

  const opened = window.open(url, '_blank', 'noopener,noreferrer')
  if (!opened) {
    throw new Error('FalconDeck could not hand this link off to your browser.')
  }
}
