import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BackupPanel } from './BackupPanel'
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

const sampleSummary = {
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

describe('BackupPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it('renders export, import, and reset sections', () => {
    render(
      <BackupPanel baseUrl="http://127.0.0.1:4317" onToast={vi.fn()} />,
    )

    expect(screen.getByRole('heading', { name: 'Backup & Data' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Export Full Backup/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Select Backup File/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reset Local Storage/i })).toBeInTheDocument()
  })

  it('handles export backup flow', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(sampleBackup)))
    const createObjectURL = vi.fn(() => 'blob:backup-export')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const onToast = vi.fn()
    render(
      <BackupPanel baseUrl="http://127.0.0.1:4317" onToast={onToast} />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Export Full Backup/i }))

    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'success',
          title: 'Backup exported successfully',
        }),
      )
    })
  })

  it('inspects uploaded file and restores on confirmation', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/inspect')) {
        return Promise.resolve(jsonResponse(sampleSummary))
      }
      if (url.endsWith('/import')) {
        return Promise.resolve(
          jsonResponse({
            workspaces_imported: 1,
            workspaces_failed: [],
            extensions_imported: 1,
            automations_imported: 0,
            connectors_imported: 0,
            providers_imported: 0,
          }),
        )
      }
      return Promise.resolve(jsonResponse({}))
    })
    vi.stubGlobal('fetch', fetchMock)

    const onToast = vi.fn()
    render(
      <BackupPanel baseUrl="http://127.0.0.1:4317" onToast={onToast} />,
    )

    const file = new File([JSON.stringify(sampleBackup)], 'my-backup.json', {
      type: 'application/json',
    })
    const input = screen.getByTestId('backup-file-input')

    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => {
      expect(screen.getByText('Preview: my-backup.json')).toBeInTheDocument()
      expect(screen.getByText('/Users/test/workspace')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /Confirm & Restore Backup/i }))

    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'success',
          title: 'Backup restored successfully',
        }),
      )
    })
  })

  it('resets local state when confirmed', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    window.localStorage.setItem('fd-appearance', JSON.stringify({ theme: 'light' }))

    const onToast = vi.fn()
    render(
      <BackupPanel baseUrl="http://127.0.0.1:4317" onToast={onToast} />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Reset Local Storage/i }))

    expect(window.localStorage.getItem('fd-appearance')).toBeNull()
    expect(onToast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'success',
        title: 'Local state reset',
      }),
    )
  })
})
