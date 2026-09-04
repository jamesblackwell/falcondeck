import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invoke } from '@tauri-apps/api/core'
import { createDaemonApiClient } from '@falcondeck/client-core'
import { DEFAULT_APPEARANCE, updateAppearance } from '@falcondeck/ui'

import {
  clearStoredOnboarding,
  readStoredOnboarding,
  readStoredOnboardingResume,
  shouldShowFirstRunOnboarding,
  writeStoredOnboarding,
  writeStoredOnboardingResume,
} from '../preferences'
import {
  ONBOARDING_STEP_INDEX,
  OnboardingWizard,
} from './OnboardingWizard'

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
    vi.clearAllMocks()
    act(() => updateAppearance(DEFAULT_APPEARANCE))
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

  it('applies and persists an appearance choice immediately', () => {
    renderWizard({ initialStep: ONBOARDING_STEP_INDEX.appearance })

    expect(screen.getByText('Choose your appearance')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    // jsdom has no matchMedia, so system resolves to light and the light
    // palettes render as a gallery; dark stays a compact dropdown.
    expect(screen.getByRole('group', { name: 'Light theme' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Falcon Light' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByLabelText('Dark theme')).toBeInTheDocument()
    expect(screen.queryByLabelText('Interface font')).toBeNull()

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'One Light' }))
    })
    expect(JSON.parse(window.localStorage.getItem('fd-appearance') ?? '{}')).toMatchObject({
      lightColorTheme: 'one-light',
    })

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Dark' }))
    })

    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('group', { name: 'Dark theme' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Falcon Dark' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(JSON.parse(window.localStorage.getItem('fd-appearance') ?? '{}')).toMatchObject({
      theme: 'dark',
    })
  })

  it('splits fonts onto the next step with a live sample', () => {
    renderWizard({ initialStep: ONBOARDING_STEP_INDEX.appearance })

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByText('Fonts and size')).toBeInTheDocument()
    expect(screen.getByText('Interface')).toBeInTheDocument()
    expect(screen.getByText('The quick brown fox jumps over the lazy dog.')).toBeInTheDocument()
    expect(screen.getByText(/Transcripts read in this face/)).toBeInTheDocument()
    expect(screen.getByLabelText('Interface font')).toBeInTheDocument()
    expect(screen.getByLabelText('Chat font')).toBeInTheDocument()
    expect(screen.getByLabelText('Code font')).toBeInTheDocument()
    expect(screen.getByText('Text size')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'System' })).toBeNull()

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Large' }))
    })
    expect(JSON.parse(window.localStorage.getItem('fd-appearance') ?? '{}')).toMatchObject({
      fontScale: 1.15,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByText('Dictate on this computer')).toBeInTheDocument()
  })

  it('offers computer-use permission grants after dictation', () => {
    window.__TAURI_INTERNALS__ = {}
    mockedInvoke.mockResolvedValue({
      accessibility: false,
      screenRecording: false,
      macosOk: true,
      macosMajor: 15,
      supported: true,
    })
    renderWizard({ initialStep: ONBOARDING_STEP_INDEX.computerUse })

    expect(screen.getByText('Let agents use your Mac')).toBeInTheDocument()
    expect(screen.getByText('Accessibility')).toBeInTheDocument()
    expect(screen.getByText('Screen Recording')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Grant' })).toHaveLength(2)
    expect(
      screen.getByRole('button', { name: 'Restart FalconDeck' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Setup continues on this step/),
    ).toBeInTheDocument()
  })

  it('reopens the computer-use step after an in-progress restart', async () => {
    window.__TAURI_INTERNALS__ = {}
    mockedInvoke.mockResolvedValue({
      accessibility: true,
      screenRecording: true,
      macosOk: true,
      macosMajor: 15,
      supported: true,
    })
    writeStoredOnboardingResume('computerUse')

    renderWizard()

    expect(await screen.findByText('Let agents use your Mac')).toBeInTheDocument()
    expect(readStoredOnboardingResume()).toBe('computerUse')
  })

  it('asks the app to restart from the computer-use step', async () => {
    window.__TAURI_INTERNALS__ = {}
    mockedInvoke.mockImplementation(async (command) => {
      if (command === 'restart_app') return
      return {
        accessibility: false,
        screenRecording: false,
        macosOk: true,
        macosMajor: 15,
        supported: true,
      }
    })
    renderWizard({ initialStep: ONBOARDING_STEP_INDEX.computerUse })

    fireEvent.click(
      await screen.findByRole('button', { name: 'Restart FalconDeck' }),
    )

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('restart_app')
    })
    expect(readStoredOnboardingResume()).toBe('computerUse')
  })

  it('enables computer use on continue after a restart even while grants are still loading', async () => {
    window.__TAURI_INTERNALS__ = {}
    let resolvePermissions: (value: unknown) => void = () => {}
    const pendingPermissions = new Promise((resolve) => {
      resolvePermissions = resolve
    })
    mockedInvoke.mockImplementation(async (command) => {
      if (command === 'computer_use_permission_status') return pendingPermissions
      return {}
    })
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        enabled: true,
        available: true,
        macos_ok: true,
        permissions: { accessibility: true, screen_recording: true },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    writeStoredOnboardingResume('computerUse')
    renderWizard()

    expect(await screen.findByText('Let agents use your Mac')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByText('Optional: OpenRouter')).toBeInTheDocument()

    resolvePermissions({
      accessibility: true,
      screenRecording: true,
      macosOk: true,
      macosMajor: 15,
      supported: true,
    })

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4317/api/computer-use',
        expect.objectContaining({ method: 'POST' }),
      )
    })
    const post = fetchMock.mock.calls.find(
      (call) => (call[1] as { method?: string } | undefined)?.method === 'POST',
    )
    expect(JSON.parse((post?.[1] as { body: string }).body)).toEqual({
      enabled: true,
    })
  })

  it('offers dictation enable, shortcut, and voice rewrite during onboarding', () => {
    renderWizard({ initialStep: ONBOARDING_STEP_INDEX.dictation })

    expect(screen.getByText('Dictate on this computer')).toBeInTheDocument()
    expect(screen.getByText('System-wide dictation')).toBeInTheDocument()
    expect(
      within(screen.getByRole('group', { name: 'Dictation shortcut' })).getByRole(
        'button',
        { name: 'Right Command' },
      ),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Rewrite selected text')).toBeInTheDocument()
    expect(
      within(screen.getByRole('group', { name: 'Rewrite shortcut' })).getByRole(
        'button',
        { name: 'Right Option' },
      ),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: 'Apple Speech' })).toBeNull()
    expect(screen.queryByText('Custom prompt')).toBeNull()
  })

  it('offers an optional OpenRouter key for read-aloud and rewrite', () => {
    renderWizard({ initialStep: ONBOARDING_STEP_INDEX.openrouter })

    expect(screen.getByText('Optional: OpenRouter')).toBeInTheDocument()
    expect(screen.getByLabelText('API key')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /get a key/i })).toHaveAttribute(
      'href',
      'https://openrouter.ai/keys',
    )
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
    await screen.findByText("You're set")
    fireEvent.click(screen.getByRole('button', { name: 'Start using FalconDeck' }))
    expect(props.onComplete).toHaveBeenCalledWith(false)
  })

  it('keeps keyboard focus inside the modal', () => {
    renderWizard()

    const first = screen.getByRole('button', {
      name: 'Or restore from a previous backup',
    })
    const continueButton = screen.getByRole('button', { name: 'Continue' })

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
      workspaces_failed: [],
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
