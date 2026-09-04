import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  collectClientBackupData,
  executeImportBackup,
  exportBackup,
  inspectBackupFile,
  resetLocalAppState,
  restoreClientBackupData,
} from './backup-service'
import type { FalconDeckBackup } from '@falcondeck/client-core'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const sampleBackup: FalconDeckBackup = {
  version: 1,
  created_at: '2026-09-04T12:00:00Z',
  app_version: '0.1.0',
  daemon: {
    preferences: {
      default_provider: 'codex',
      sound_effects_enabled: true,
      workspace_colors: {},
    },
    workspaces: [
      {
        path: '/Users/test/workspace',
        kind: 'project',
        pinned: true,
        threads: [],
      },
    ],
    extensions: {
      enabled: ['notes'],
      grants: {},
      storage: {
        notes: { notes: [] },
      },
    },
    control: {
      settings: null,
      automations: [],
    },
    connectors: {
      mcp_servers: [],
    },
    providers: {
      acp_providers: [],
    },
  },
  client: {
    appearance: { theme: 'dark' },
    sounds: { enabled: true, soundId: 'glass' },
    shortcuts: null,
    dictation: null,
    ui_preferences: {
      threadSort: 'last_updated',
      collapsedWorkspaces: [],
      chatsCollapsed: 'false',
      projectsCollapsed: 'false',
    },
  },
}

describe('backup-service', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it('collects and restores client backup data to/from localStorage', () => {
    window.localStorage.setItem('fd-appearance', JSON.stringify({ theme: 'light' }))
    window.localStorage.setItem(
      'falcondeck.desktop.sounds.v1',
      JSON.stringify({ enabled: false, soundId: 'drop' }),
    )
    window.localStorage.setItem('falcondeck.desktop.thread-sort.v1', 'alphabetical')

    const collected = collectClientBackupData()
    expect(collected.appearance).toEqual({ theme: 'light' })
    expect(collected.sounds).toEqual({ enabled: false, soundId: 'drop' })
    expect(collected.ui_preferences?.threadSort).toBe('alphabetical')

    window.localStorage.clear()

    restoreClientBackupData(collected)
    expect(JSON.parse(window.localStorage.getItem('fd-appearance') ?? '{}')).toEqual({
      theme: 'light',
    })
    expect(
      JSON.parse(window.localStorage.getItem('falcondeck.desktop.sounds.v1') ?? '{}'),
    ).toEqual({ enabled: false, soundId: 'drop' })
    expect(window.localStorage.getItem('falcondeck.desktop.thread-sort.v1')).toBe(
      'alphabetical',
    )
  })

  it('resets local app state keys from localStorage', () => {
    window.localStorage.setItem('fd-appearance', JSON.stringify({ theme: 'dark' }))
    window.localStorage.setItem('falcondeck.desktop.onboarding.v1', JSON.stringify({ done: true }))

    resetLocalAppState()

    expect(window.localStorage.getItem('fd-appearance')).toBeNull()
    expect(window.localStorage.getItem('falcondeck.desktop.onboarding.v1')).toBeNull()
  })

  it('inspects valid backup file by querying daemon API', async () => {
    const summary = {
      version: 1,
      created_at: sampleBackup.created_at,
      app_version: sampleBackup.app_version,
      workspace_count: 1,
      workspaces: [{ path: '/Users/test/workspace', exists_on_disk: true }],
      extension_count: 1,
      extensions: ['notes'],
      automation_count: 0,
      connector_count: 0,
      provider_count: 0,
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(summary)))

    const file = new File([JSON.stringify(sampleBackup)], 'test-backup.json', {
      type: 'application/json',
    })

    const result = await inspectBackupFile(file, 'http://127.0.0.1:4317')
    expect(result.summary.workspace_count).toBe(1)
    expect(result.backup.version).toBe(1)
  })

  it('rejects invalid JSON or non-backup objects during inspection', async () => {
    const invalidJson = new File(['not json'], 'bad.json', { type: 'application/json' })
    let invalidError: Error | null = null
    try {
      await inspectBackupFile(invalidJson, 'http://127.0.0.1:4317')
    } catch (err) {
      invalidError = err as Error
    }
    expect(invalidError?.message).toMatch(/not valid JSON/)

    const randomJson = new File(['{"foo": 123}'], 'bad.json', { type: 'application/json' })
    let randomError: Error | null = null
    try {
      await inspectBackupFile(randomJson, 'http://127.0.0.1:4317')
    } catch (err) {
      randomError = err as Error
    }
    expect(randomError?.message).toMatch(/FalconDeck backup archive/)
  })

  it('executes import backup and restores client preferences', async () => {
    const importResponse = {
      workspaces_imported: 1,
      workspaces_failed: [],
      extensions_imported: 1,
      automations_imported: 0,
      connectors_imported: 0,
      providers_imported: 0,
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(importResponse)))

    const response = await executeImportBackup(sampleBackup, {}, 'http://127.0.0.1:4317')
    expect(response.workspaces_imported).toBe(1)
    expect(JSON.parse(window.localStorage.getItem('fd-appearance') ?? '{}')).toEqual({
      theme: 'dark',
    })
  })

  it('exports backup, attaches client data, and triggers download', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(sampleBackup)))
    const createObjectURL = vi.fn(() => 'blob:backup-export')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })

    let downloadedFileName: string | null = null
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      function captureClick(this: HTMLAnchorElement) {
        downloadedFileName = this.download
      },
    )

    window.localStorage.setItem('fd-appearance', JSON.stringify({ theme: 'light' }))

    const exported = await exportBackup('http://127.0.0.1:4317')
    expect(exported.client?.appearance).toEqual({ theme: 'light' })
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(downloadedFileName).toMatch(/^falcondeck-backup-.*\.json$/)
  })
})
