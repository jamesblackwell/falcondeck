import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as backupService from '../backup-service'

import { invoke } from '@tauri-apps/api/core'
import { createDaemonApiClient } from '@falcondeck/client-core'

import {
  clearStoredOnboarding,
  readStoredOnboarding,
  readStoredOnboardingResume,
  shouldShowFirstRunOnboarding,
  writeStoredOnboarding,
  writeStoredOnboardingResume,
} from '../preferences'
import { OnboardingWizard } from './OnboardingWizard'
import { ONBOARDING_STEP_INDEX } from './onboarding-steps'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

const mockedInvoke = vi.mocked(invoke)

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const overview = {
  host: 'local',
  harnesses: [
    {
      id: 'codex',
      label: 'Codex',
      kind: 'builtin',
      bin: 'codex',
      resolved_path: '/usr/local/bin/codex',
      installed: true,
      version: '0.12.0',
      latest_version: '0.13.0',
      update_available: true,
      upgrade_command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
      account_status: 'Logged in using ChatGPT',
    },
    {
      id: 'custom-agent',
      label: 'Custom Agent',
      kind: 'detected',
      bin: 'custom-agent',
      installed: false,
    },
  ],
}

function renderWizard(overrides: Partial<Parameters<typeof OnboardingWizard>[0]> = {}) {
  const props = {
    api: createDaemonApiClient('http://127.0.0.1:4317'),
    baseUrl: null,
    workspacesCount: 0,
    isImportingSessions: false,
    onAddProject: vi.fn(),
    onToast: vi.fn(),
    onComplete: vi.fn(),
    ...overrides,
  }
  render(<OnboardingWizard {...props} />)
  return props
}

describe('onboarding flag helpers', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('round-trips a completion record', () => {
    expect(readStoredOnboarding()).toBeNull()
    writeStoredOnboarding({
      completedAt: '2026-08-17T00:00:00.000Z',
      skipped: false,
      wizardVersion: 1,
    })
    expect(readStoredOnboarding()).toEqual({
      completedAt: '2026-08-17T00:00:00.000Z',
      skipped: false,
      wizardVersion: 1,
    })
  })

  it('treats a corrupt record as not completed', () => {
    window.localStorage.setItem('falcondeck.desktop.onboarding.v1', '{not json')
    expect(readStoredOnboarding()).toBeNull()
    window.localStorage.setItem(
      'falcondeck.desktop.onboarding.v1',
      JSON.stringify({ completedAt: 'whenever' }),
    )
    expect(readStoredOnboarding()).toBeNull()
  })

  it('clear only removes the onboarding flag', () => {
    window.localStorage.setItem('falcondeck.desktop.onboarding.v1', '{"x":1}')
    window.localStorage.setItem('falcondeck.desktop.thread-sort.v1', 'last_updated')
    clearStoredOnboarding()
    expect(readStoredOnboarding()).toBeNull()
    expect(window.localStorage.getItem('falcondeck.desktop.thread-sort.v1')).toBe(
      'last_updated',
    )
  })

  it('round-trips an in-progress resume step and clears it on complete or rerun', () => {
    writeStoredOnboardingResume('computerUse')
    expect(readStoredOnboardingResume()).toBe('computerUse')
    writeStoredOnboarding({
      completedAt: '2026-08-17T00:00:00.000Z',
      skipped: false,
      wizardVersion: 1,
    })
    expect(readStoredOnboardingResume()).toBeNull()

    writeStoredOnboardingResume('computerUse')
    window.localStorage.setItem('falcondeck.desktop.thread-sort.v1', 'last_updated')
    clearStoredOnboarding()
    expect(readStoredOnboardingResume()).toBeNull()
    expect(window.localStorage.getItem('falcondeck.desktop.thread-sort.v1')).toBe(
      'last_updated',
    )
  })
})

describe('shouldShowFirstRunOnboarding', () => {
  const base = {
    isTauri: true,
    eligibleThisLaunch: true,
    onboardingRecord: null,
    connectionState: 'ready' as const,
  }

  it('shows on a fresh Tauri install once the daemon is ready', () => {
    expect(shouldShowFirstRunOnboarding(base)).toBe(true)
  })

  it('never shows outside Tauri, before the daemon is ready, or once completed', () => {
    expect(shouldShowFirstRunOnboarding({ ...base, isTauri: false })).toBe(false)
    expect(
      shouldShowFirstRunOnboarding({ ...base, connectionState: 'connecting' }),
    ).toBe(false)
    expect(
      shouldShowFirstRunOnboarding({ ...base, connectionState: 'error' }),
    ).toBe(false)
    expect(
      shouldShowFirstRunOnboarding({
        ...base,
        onboardingRecord: {
          completedAt: '2026-08-17T00:00:00.000Z',
          skipped: false,
          wizardVersion: 1,
        },
      }),
    ).toBe(false)
  })

  it('stays closed after the rerun control clears storage mid-session', () => {
    // The in-session record survives the Settings → General rerun click, so
    // the wizard reopens only on the next launch despite storage being empty.
    expect(
      shouldShowFirstRunOnboarding({
        ...base,
        onboardingRecord: {
          completedAt: '2026-08-17T00:00:00.000Z',
          skipped: false,
          wizardVersion: 1,
        },
      }),
    ).toBe(false)
    expect(readStoredOnboarding()).toBeNull()
  })
})

describe('OnboardingWizard', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.clearAllMocks()
    window.localStorage.clear()
    delete window.__TAURI_INTERNALS__
  })

  it('opens on the welcome step and skips via the explicit skip button', () => {
    const props = renderWizard()

    expect(screen.getByText('Welcome to FalconDeck')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }))
    expect(props.onComplete).toHaveBeenCalledWith(true)
  })

  it('probes harnesses when advancing to the tools step', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(overview))
    vi.stubGlobal('fetch', fetchMock)
    const props = renderWizard({ initialStep: ONBOARDING_STEP_INDEX.tools })

    expect(await screen.findByText('Codex')).toBeInTheDocument()
    expect(screen.getByText('Update available')).toBeInTheDocument()
    expect(screen.getByText('Logged in using ChatGPT')).toBeInTheDocument()
    // Detection-only harness shows no install button.
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4317/api/harnesses/refresh',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(props.onComplete).not.toHaveBeenCalled()
  })

  it('finishes the four-step flow without configuring optional features', async () => {
    mockedInvoke.mockResolvedValue('default')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(overview)))
    const props = renderWizard()

    expect(screen.getByRole('status')).toHaveTextContent('Step 1 of 4')
    fireEvent.click(screen.getByRole('button', { name: 'Quick setup' }))
    expect(await screen.findByText('Codex')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Step 2 of 4')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByText('Add your first project')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Step 3 of 4')
    fireEvent.click(screen.getByRole('button', { name: 'Choose a folder…' }))
    expect(props.onAddProject).toHaveBeenCalledOnce()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    })
    expect(screen.getByText('Ready when you are')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Step 4 of 4')
    fireEvent.click(screen.getByRole('button', { name: 'Start using FalconDeck' }))
    expect(props.onComplete).toHaveBeenCalledWith(false)
    expect(mockedInvoke).toHaveBeenCalledWith('macos_notification_permission_state')
    expect(mockedInvoke).not.toHaveBeenCalledWith('request_macos_notification_permission')
    expect(screen.queryByLabelText('API key')).toBeNull()
  })

  it.each(['appearance', 'fonts', 'dictation', 'computerUse', 'openrouter'])(
    'resumes a removed %s step at agent setup without enabling extra features', async (step) => {
      writeStoredOnboardingResume(step)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(overview)))
      renderWizard()

      expect(await screen.findByText('Codex')).toBeInTheDocument()
      expect(readStoredOnboardingResume()).toBe('tools')
      expect(mockedInvoke).not.toHaveBeenCalled()
    },
  )

  it('leaves setup with Escape', () => {
    const props = renderWizard({ initialStep: ONBOARDING_STEP_INDEX.project })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(props.onComplete).toHaveBeenCalledWith(true)
  })

  it('keeps installed agents visible and reveals other agents on demand', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      ...overview,
      harnesses: [...overview.harnesses, {
        id: 'pi', label: 'Pi', kind: 'detected', bin: 'pi', installed: true,
        update_available: false, upgrade_command: 'npm install -g pi',
      }],
    })))
    renderWizard({ initialStep: ONBOARDING_STEP_INDEX.tools })

    expect(await screen.findByText('Pi')).toBeInTheDocument()
    expect(screen.queryByText('Custom Agent')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show more agents' }))
    expect(screen.getByText('Custom Agent')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show fewer agents' })).toHaveAttribute('aria-expanded', 'true')
    // A current installed agent does not need an update before starting.
    expect(screen.getAllByRole('button', { name: 'Update' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer agents' }))
    expect(screen.queryByText('Custom Agent')).toBeNull()
    expect(screen.getByText('Pi')).toBeInTheDocument()
  })

  it('refreshes the displayed harness version after an upgrade completes', async () => {
    const pi = {
      host: 'local',
      harnesses: [
        {
          id: 'pi',
          label: 'Pi',
          kind: 'detected',
          bin: 'pi-acp',
          installed: true,
          version: '0.22.5',
          latest_version: '0.55.1',
          update_available: true,
          upgrade_command:
            'npm install -g --ignore-scripts @earendil-works/pi-coding-agent pi-acp',
        },
      ],
    }
    const updatedPi = {
      ...pi,
      harnesses: [
        {
          ...pi.harnesses[0],
          version: '0.55.1',
          update_available: false,
        },
      ],
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(pi))
      .mockResolvedValueOnce(jsonResponse({ job_id: 'job-pi' }))
      .mockResolvedValueOnce(
        jsonResponse({
          job_id: 'job-pi',
          harness_id: 'pi',
          label: 'Pi',
          host: 'local',
          status: 'completed',
          log: ['installed'],
          error: null,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(updatedPi))
    vi.stubGlobal('fetch', fetchMock)
    const onToast = vi.fn()
    renderWizard({ onToast, initialStep: ONBOARDING_STEP_INDEX.tools })

    fireEvent.click(await screen.findByRole('button', { name: 'Update' }))

    expect(await screen.findByText('v0.55.1')).toBeInTheDocument()
    expect(screen.getByText('Installed')).toBeInTheDocument()
    expect(screen.queryByText('Update available')).toBeNull()
    expect(onToast).toHaveBeenCalledWith({
      variant: 'success',
      title: 'Pi updated',
      description: 'Updated the install FalconDeck uses on This Mac.',
    })
  })

  it('completes from the finish step', async () => {
    mockedInvoke.mockResolvedValue('granted')
    // Passing through the tools step fires a harness probe; keep it offline.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const props = renderWizard({
      workspacesCount: 1,
      initialStep: ONBOARDING_STEP_INDEX.project,
    })

    // Already-connected project renders as done on the project step.
    expect(
      screen.getByText(
        (_, element) => element?.textContent === '1 project connected',
      ),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByText('Ready when you are')
    fireEvent.click(screen.getByRole('button', { name: 'Start using FalconDeck' }))
    expect(props.onComplete).toHaveBeenCalledWith(false)
  })

  it('keeps keyboard focus inside the modal', () => {
    renderWizard({ baseUrl: 'http://127.0.0.1:4317' })

    const first = screen.getByRole('button', {
      name: 'Or restore from a previous backup',
    })
    const continueButton = screen.getByRole('button', { name: 'Quick setup' })

    continueButton.focus()
    fireEvent.keyDown(continueButton, { key: 'Tab' })
    expect(first).toHaveFocus()

    first.focus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(continueButton).toHaveFocus()
  })

  it('recovers when the daemon loses an install job (restart)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse({ job_id: 'job-1' }, 200))
      .mockResolvedValue(
        jsonResponse({ error: 'unknown harness job: job-1' }, 404),
      )
    vi.stubGlobal('fetch', fetchMock)
    const onToast = vi.fn()
    renderWizard({ onToast, initialStep: ONBOARDING_STEP_INDEX.tools })

    fireEvent.click(await screen.findByRole('button', { name: 'Update' }))

    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'warning',
          title: 'codex install status lost',
        }),
      )
    })
    // The job clears, so install controls re-enable instead of bricking.
    expect(await screen.findByRole('button', { name: 'Update' })).toBeInTheDocument()
  })

  it('reads the macOS notification state when the finish step opens', async () => {
    mockedInvoke.mockResolvedValue('granted')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    renderWizard({ initialStep: ONBOARDING_STEP_INDEX.finish })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('macos_notification_permission_state')
    })
    expect(await screen.findByText('Notifications enabled')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Enable notifications' }),
    ).toBeNull()
  })

  it('disables restore until the daemon URL is available', () => {
    renderWizard()
    expect(screen.getByRole('button', { name: /restore from a previous backup/i })).toBeDisabled()
  })

  it('locks install controls while the start request is pending and recovers on failure', async () => {
    let rejectInstall!: (reason: Error) => void
    const api = createDaemonApiClient('http://127.0.0.1:4317')
    vi.spyOn(api, 'refreshHarnesses').mockResolvedValue(overview)
    const upgrade = vi.spyOn(api, 'upgradeHarness').mockImplementation(() =>
      new Promise((_, reject) => { rejectInstall = reject }),
    )
    const props = renderWizard({ api, initialStep: ONBOARDING_STEP_INDEX.tools })
    const update = await screen.findByRole('button', { name: 'Update' })
    fireEvent.click(update)
    fireEvent.click(update)
    expect(upgrade).toHaveBeenCalledTimes(1)
    expect(update).toBeDisabled()
    expect(screen.getByText('Starting…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeDisabled()
    await act(async () => rejectInstall(new Error('offline')))
    expect(update).toBeEnabled()
    expect(props.onToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not start Codex update' }))
  })

  it('keeps setup open and reports actual counts when restore skips projects', async () => {
    vi.spyOn(backupService, 'inspectBackupFile').mockResolvedValue({ backup: {} } as Awaited<ReturnType<typeof backupService.inspectBackupFile>>)
    vi.spyOn(backupService, 'executeImportBackup').mockResolvedValue({
      workspaces_imported: 1, workspaces_skipped: 2, extensions_imported: 3,
      automations_imported: 0, connectors_imported: 0, providers_imported: 0,
      preferences_restored: true,
    })
    const props = renderWizard({ baseUrl: 'http://127.0.0.1:4317' })
    fireEvent.change(screen.getByTestId('onboarding-backup-file-input'), {
      target: { files: [new File(['{}'], 'backup.json')] },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('Restored 1 project(s) and 3 extension(s). 2 project(s) could not be connected.')
    expect(props.onComplete).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Quick setup' })).toBeEnabled()
  })

  it('prevents leaving setup during a restore and unlocks after failure', async () => {
    let rejectRestore!: (reason: Error) => void
    vi.spyOn(backupService, 'inspectBackupFile').mockImplementation(() =>
      new Promise((_, reject) => { rejectRestore = reject }),
    )
    const props = renderWizard({ baseUrl: 'http://127.0.0.1:4317' })
    fireEvent.change(screen.getByTestId('onboarding-backup-file-input'), {
      target: { files: [new File(['{}'], 'backup.json')] },
    })
    expect(screen.getByRole('button', { name: 'Quick setup' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Skip setup' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(props.onComplete).not.toHaveBeenCalled()
    await act(async () => rejectRestore(new Error('Invalid backup')))
    expect(screen.getByRole('button', { name: 'Quick setup' })).toBeEnabled()
    expect(props.onComplete).not.toHaveBeenCalled()
    expect(props.onToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not restore backup' }))
  })

  it('explains denied notifications without offering an ineffective permission request', async () => {
    mockedInvoke.mockResolvedValue('denied')
    renderWizard({ initialStep: ONBOARDING_STEP_INDEX.finish })
    expect(await screen.findByText(/enable FalconDeck in System Settings/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Enable notifications' })).toBeNull()
  })

  it('allows restoring from a backup archive in step 0', async () => {
    const summary = {
      version: 1,
      created_at: '2026-09-04T12:00:00Z',
      workspace_count: 2,
      workspaces: [],
      extension_count: 3,
      extensions: [],
      automation_count: 1,
      connector_count: 0,
      provider_count: 0,
    }
    const importResult = {
      workspaces_imported: 2,
      workspaces_skipped: 0,
      extensions_imported: 3,
      automations_imported: 1,
      connectors_imported: 0,
      providers_imported: 0,
    }

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/inspect')) {
        return Promise.resolve(jsonResponse(summary))
      }
      if (url.endsWith('/import')) {
        return Promise.resolve(jsonResponse(importResult))
      }
      return Promise.resolve(jsonResponse({}))
    })
    vi.stubGlobal('fetch', fetchMock)

    const onToast = vi.fn()
    const onComplete = vi.fn()
    renderWizard({
      baseUrl: 'http://127.0.0.1:4317',
      onToast,
      onComplete,
      initialStep: ONBOARDING_STEP_INDEX.welcome,
    })

    expect(
      screen.getByRole('button', { name: /Or restore from a previous backup/i }),
    ).toBeInTheDocument()

    const backupData = {
      version: 1,
      created_at: '2026-09-04T12:00:00Z',
      daemon: {
        preferences: {},
        workspaces: [],
        extensions: { enabled: [], grants: {}, storage: {} },
        control: { settings: null, automations: [] },
        connectors: { mcp_servers: [] },
        providers: { acp_providers: [] },
      },
    }
    const file = new File([JSON.stringify(backupData)], 'falcondeck-backup.json', {
      type: 'application/json',
    })
    const input = screen.getByTestId('onboarding-backup-file-input')

    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'success',
          title: 'Backup restored',
        }),
      )
      expect(onComplete).toHaveBeenCalledWith(false)
    })
  })
})
