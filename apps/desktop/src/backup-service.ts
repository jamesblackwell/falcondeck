import {
  createDaemonApiClient,
  type BackupSummary,
  type ClientBackupData,
  type FalconDeckBackup,
  type ImportBackupResponse,
} from '@falcondeck/client-core'

const CLIENT_STORAGE_KEYS = {
  appearance: 'fd-appearance',
  sounds: 'falcondeck.desktop.sounds.v1',
  shortcuts: 'falcondeck.shortcuts.v1',
  dictation: 'falcondeck.desktop.dictation.v2',
  onboarding: 'falcondeck.desktop.onboarding.v1',
  onboardingResume: 'falcondeck.desktop.onboarding.resume.v1',
  threadSort: 'falcondeck.desktop.thread-sort.v1',
  collapsedWorkspaces: 'falcondeck.desktop.collapsed-workspaces.v1',
  chatsCollapsed: 'falcondeck.desktop.chats-collapsed.v1',
  projectsCollapsed: 'falcondeck.desktop.projects-collapsed.v1',
  panelVisibility: 'falcondeck.desktop.panel-visibility.v1',
} as const

export function collectClientBackupData(): ClientBackupData {
  const parseJson = (key: string): unknown => {
    try {
      const val = window.localStorage.getItem(key)
      return val ? JSON.parse(val) : null
    } catch {
      return null
    }
  }

  return {
    appearance: parseJson(CLIENT_STORAGE_KEYS.appearance),
    sounds: parseJson(CLIENT_STORAGE_KEYS.sounds),
    shortcuts: parseJson(CLIENT_STORAGE_KEYS.shortcuts),
    dictation: parseJson(CLIENT_STORAGE_KEYS.dictation),
    ui_preferences: {
      threadSort: window.localStorage.getItem(CLIENT_STORAGE_KEYS.threadSort),
      collapsedWorkspaces: parseJson(CLIENT_STORAGE_KEYS.collapsedWorkspaces),
      chatsCollapsed: window.localStorage.getItem(CLIENT_STORAGE_KEYS.chatsCollapsed),
      projectsCollapsed: window.localStorage.getItem(CLIENT_STORAGE_KEYS.projectsCollapsed),
      panelVisibility: parseJson(CLIENT_STORAGE_KEYS.panelVisibility),
    },
  }
}

export function restoreClientBackupData(client?: ClientBackupData | null): void {
  if (!client) return

  const setJson = (key: string, value: unknown) => {
    if (value != null) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch (err) {
        console.warn(`Failed to restore ${key} to localStorage:`, err)
      }
    }
  }

  setJson(CLIENT_STORAGE_KEYS.appearance, client.appearance)
  setJson(CLIENT_STORAGE_KEYS.sounds, client.sounds)
  setJson(CLIENT_STORAGE_KEYS.shortcuts, client.shortcuts)
  setJson(CLIENT_STORAGE_KEYS.dictation, client.dictation)

  if (client.ui_preferences && typeof client.ui_preferences === 'object') {
    const prefs = client.ui_preferences as Record<string, unknown>
    if (typeof prefs.threadSort === 'string') {
      window.localStorage.setItem(CLIENT_STORAGE_KEYS.threadSort, prefs.threadSort)
    }
    if (prefs.collapsedWorkspaces != null) {
      setJson(CLIENT_STORAGE_KEYS.collapsedWorkspaces, prefs.collapsedWorkspaces)
    }
    if (typeof prefs.chatsCollapsed === 'string') {
      window.localStorage.setItem(CLIENT_STORAGE_KEYS.chatsCollapsed, prefs.chatsCollapsed)
    }
    if (typeof prefs.projectsCollapsed === 'string') {
      window.localStorage.setItem(CLIENT_STORAGE_KEYS.projectsCollapsed, prefs.projectsCollapsed)
    }
    if (prefs.panelVisibility != null) {
      setJson(CLIENT_STORAGE_KEYS.panelVisibility, prefs.panelVisibility)
    }
  }
}

export function triggerBackupDownload(backup: FalconDeckBackup): void {
  const jsonStr = JSON.stringify(backup, null, 2)
  const blob = new Blob([jsonStr], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const fileName = `falcondeck-backup-${dateStr}.json`

  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export async function exportBackup(baseUrl: string): Promise<FalconDeckBackup> {
  const client = createDaemonApiClient(baseUrl)
  const daemonBackup = await client.exportBackup()
  const fullBackup: FalconDeckBackup = {
    ...daemonBackup,
    client: collectClientBackupData(),
  }
  triggerBackupDownload(fullBackup)
  return fullBackup
}

async function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') {
    return file.text()
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string) || '')
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

export async function inspectBackupFile(
  file: File,
  baseUrl: string,
): Promise<{ backup: FalconDeckBackup; summary: BackupSummary }> {
  const text = await readFileText(file)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`The selected file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('version' in parsed) ||
    !('daemon' in parsed)
  ) {
    throw new Error('The selected file does not appear to be a FalconDeck backup archive.')
  }

  const backup = parsed as FalconDeckBackup
  const client = createDaemonApiClient(baseUrl)
  const summary = await client.inspectBackup(backup)
  return { backup, summary }
}

export async function executeImportBackup(
  backup: FalconDeckBackup,
  pathMappings: Record<string, string>,
  baseUrl: string,
): Promise<ImportBackupResponse> {
  const client = createDaemonApiClient(baseUrl)
  const result = await client.importBackup({ backup, pathMappings })
  restoreClientBackupData(backup.client)
  return result
}

export function resetLocalAppState(): void {
  for (const key of Object.values(CLIENT_STORAGE_KEYS)) {
    window.localStorage.removeItem(key)
  }
}
