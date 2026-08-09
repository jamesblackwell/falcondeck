import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { SettingsView, type SettingsViewProps } from './SettingsView'

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
    expect(screen.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Appearance/ }))
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument()
    rerender(<SettingsView {...props} initialSection="keyboard" sectionRequestKey={1} />)
    expect(screen.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeInTheDocument()
  })
})
