import React from 'react'

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { RemoteStatusResponse } from '@falcondeck/client-core'

import { RemoteAccessPanel } from './RemoteAccessPanel'

function remoteStatus(): RemoteStatusResponse {
  return {
    status: 'inactive',
    relay_url: 'https://connect.falcondeck.com',
    pairing: null,
    trusted_devices: [],
    presence: null,
    last_error: null,
  }
}

describe('RemoteAccessPanel', () => {
  it('disables pairing controls until the daemon client is ready', () => {
    render(
      <RemoteAccessPanel
        remoteStatus={remoteStatus()}
        pairingLink={null}
        relayUrl="https://connect.falcondeck.com"
        isStartingRemote={false}
        remoteControlsDisabled
        remoteControlsUnavailableReason="FalconDeck is still connecting to the local daemon."
        revokingDeviceId={null}
        onStartPairing={vi.fn()}
        onRefreshRemoteStatus={vi.fn()}
        onRevokeDevice={vi.fn()}
      />,
    )

    expect(screen.getByText('FalconDeck is still connecting to the local daemon.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start pairing/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /refresh status/i })).toBeDisabled()
  })
})
