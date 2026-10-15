import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { SettingsView, type SettingsViewProps } from './SettingsView'
import { SETTINGS_NAV } from './settings/settings-utils'

const props = {
  initialSection: 'appearance',
  workspace: null,
  localWorkspaces: [],
  baseUrl: null,
  hostManager: {},
  hosts: [],
  onToast: vi.fn(),
  preferences: null,
  remoteStatus: null,
  pairingLink: null,
  relayUrl: '',
  isStartingRemote: false,
  remoteControlsDisabled: true,
  remoteControlsUnavailableReason: null,
  revokingDeviceId: null,
  updater: {},
  updaterProgressPercent: null,
  onUpdatePreferences: vi.fn(),
  onStartPairing: vi.fn(),
  onRefreshRemoteStatus: vi.fn(),
  onRevokeDevice: vi.fn(),
  onCheckForUpdates: vi.fn(),
  onDownloadUpdate: vi.fn(),
  onRestartToInstallUpdate: vi.fn(),
  onClose: vi.fn(),
} as unknown as SettingsViewProps

describe('SettingsView deep links', () => {
  beforeAll(() => {
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia
  })

  it('updates the active section when an already-mounted view receives a shortcut request', () => {
    const { rerender } = render(<SettingsView {...props} />)
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument()

    rerender(<SettingsView {...props} initialSection="keyboard" />)
    expect(screen.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Appearance/ }))
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument()
    rerender(<SettingsView {...props} initialSection="keyboard" sectionRequestKey={1} />)
    expect(screen.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
  })

  it('exposes the daemon-owned automatic session recovery switch in General', () => {
    const onUpdatePreferences = vi.fn()
    render(
      <SettingsView
        {...props}
        initialSection="general"
        preferences={{ auto_resume_interrupted_sessions: true } as SettingsViewProps['preferences']}
        onUpdatePreferences={onUpdatePreferences}
      />,
    )
    const toggle = screen.getByRole('switch', { name: 'Automatically continue stopped sessions' })
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    expect(onUpdatePreferences).toHaveBeenCalledWith({ auto_resume_interrupted_sessions: false })
  })

  it('does not expose a second settings-only automation manager', () => {
    render(<SettingsView {...props} />)
    expect(screen.queryByRole('button', { name: /Automations/ })).not.toBeInTheDocument()
  })

  it('searches settings and opens the page holding the match', () => {
    render(<SettingsView {...props} initialSection="general" />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), {
      target: { value: 'title prompt' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Models & keys/ }))
    expect(screen.getByRole('heading', { name: 'Models & keys' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Title prompt' })).toBeInTheDocument()
  })

  it('lists matching settings under their page and says when nothing matches', () => {
    render(<SettingsView {...props} />)
    const search = screen.getByRole('searchbox', { name: 'Search settings' })
    fireEvent.change(search, { target: { value: 'failed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Failed turns' }))
    expect(screen.getByRole('heading', { name: 'Notifications' })).toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'zzzz' } })
    expect(screen.getByText(/No settings match/)).toBeInTheDocument()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(search).toHaveValue('')
  })

  it('keeps OpenRouter and title settings out of Voice', () => {
    render(<SettingsView {...props} initialSection="speech" />)
    expect(screen.getByRole('heading', { name: 'Voice' })).toBeInTheDocument()
    expect(screen.queryByText('Suggest title')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }))
    expect(screen.getByRole('heading', { name: 'Models & keys' })).toBeInTheDocument()
    expect(screen.getByLabelText(/API key/)).toBeInTheDocument()
  })

  // Search scrolls to these exact titles, so they must exist on the page.
  // Agent control loads from the daemon; dictionary and history are Tauri-only.
  const offlineSections = new Set(['agent-control'])
  const tauriOnly = new Set(['Correction dictionary', 'Recording history'])
  const workspace = {
    agents: [{ provider: 'codex', account: { status: 'ready', label: 'Signed in' }, models: [] }],
    last_error: null,
  } as unknown as SettingsViewProps['workspace']
  it.each(
    SETTINGS_NAV.filter(
      (item) => item.settings.length > 0 && !offlineSections.has(item.id),
    ).map((item) => [item.id, item] as const),
  )(
    'every searchable setting on %s is rendered with the same title',
    (_id, item) => {
      render(<SettingsView {...props} workspace={workspace} initialSection={item.id} />)
      for (const setting of item.settings.filter((title) => !tauriOnly.has(title))) {
        expect(screen.getAllByText(setting, { exact: true }).length).toBeGreaterThan(0)
      }
    },
  )
})
