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

export async function openLocalPath(path: string) {
  if (!isTauriDesktop()) {
    throw new Error('Opening local paths is only available in the FalconDeck desktop app.')
  }

  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('open_local_path', { path })
}

export async function revealLocalPath(path: string) {
  if (!isTauriDesktop()) {
    throw new Error('Revealing local paths is only available in the FalconDeck desktop app.')
  }

  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('reveal_local_path', { path })
}

export type DesktopEditor = { id: string; name: string }

export async function listDesktopEditors(): Promise<DesktopEditor[]> {
  if (!isTauriDesktop()) {
    return []
  }

  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<DesktopEditor[]>('list_installed_editors')
}

export async function openLocalPathWithEditor(path: string, editor: string) {
  if (!isTauriDesktop()) {
    throw new Error('Opening paths in an editor is only available in the FalconDeck desktop app.')
  }

  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('open_path_with_editor', { path, editor })
}

/** "file" or "directory" for paths that exist, null otherwise. */
export async function localPathKind(
  path: string,
): Promise<'file' | 'directory' | null> {
  if (!isTauriDesktop()) {
    return null
  }

  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<'file' | 'directory' | null>('local_path_kind', { path })
}

export async function readLocalTextFile(path: string) {
  if (!isTauriDesktop()) {
    throw new Error('Reading local files is only available in the FalconDeck desktop app.')
  }

  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<string>('read_local_text_file', { path })
}

/**
 * Ask where to save a copy of `source`, then copy it there. Returns false
 * when the user dismisses the dialog.
 */
export async function saveLocalFileAs(source: string) {
  if (!isTauriDesktop()) {
    throw new Error('Saving local files is only available in the FalconDeck desktop app.')
  }

  const { save } = await import('@tauri-apps/plugin-dialog')
  const defaultName = source.split(/[\\/]/).filter(Boolean).pop() ?? source
  const dest = await save({ defaultPath: defaultName })
  if (!dest) {
    return false
  }

  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('copy_local_file', { source, dest })
  return true
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
