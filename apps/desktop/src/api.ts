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
