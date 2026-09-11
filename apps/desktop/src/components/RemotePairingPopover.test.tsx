import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RemoteStatusResponse } from '@falcondeck/client-core'
import { ToastProvider } from '@falcondeck/ui'

import { RemotePairingPopover } from './RemotePairingPopover'

type MockButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  children?: React.ReactNode
}

type MockCopyButtonProps = {
  text: string
  className?: string
  label?: string
}

vi.mock('@falcondeck/ui', async () => {
  const actual = await vi.importActual<typeof import('@falcondeck/ui')>('@falcondeck/ui')

  return {
    ...actual,
    Button: ({ children, ...props }: MockButtonProps) => (
      <button {...props}>{children}</button>
    ),
    CopyButton: ({ text, className, label = 'Copy' }: MockCopyButtonProps) => (
      <button type="button" className={className} data-copy-text={text}>
        {label}
      </button>
    ),
    StatusIndicator: () => <span data-testid="status-indicator" />,
  }
})

const pairingLink = 'https://falcondeck.com/pair?code=YMZEYPB2EZTA'
const pairingQrValue = 'falcondeck://pair?code=YMZEYPB2EZTA'

/** Pinned so countdown assertions do not race the wall clock. */
const NOW = Date.parse('2026-08-08T12:00:00Z')

function remoteStatus(expiresAt = '2026-08-08T12:10:00Z'): RemoteStatusResponse {
  return {
    status: 'pairing_pending',
    relay_url: 'https://connect.falcondeck.com',
    pairing: {
      pairing_id: 'pairing-1',
      pairing_code: 'YMZEYPB2EZTA',
      session_id: null,
      expires_at: expiresAt,
    },
    trusted_devices: [],
    presence: null,
    last_error: null,
  }
}

function renderPopover(status: RemoteStatusResponse = remoteStatus(), onStartPairing = () => {}) {
  render(
    <ToastProvider>
      <RemotePairingPopover
        remoteStatus={status}
        pairingLink={pairingLink}
        pairingQrValue={pairingQrValue}
        onStartPairing={onStartPairing}
        isStartingRemote={false}
        remoteControlsDisabled={false}
        remoteControlsUnavailableReason={null}
      />
    </ToastProvider>,
  )
}

describe('RemotePairingPopover', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('copies the HTTPS pairing link and does not offer a web client', async () => {
    renderPopover()

    fireEvent.click(screen.getByRole('button', { name: /waiting/i }))
    const copyLink = await screen.findByRole('button', { name: /copy link/i })
    expect(copyLink).toHaveAttribute('data-copy-text', pairingLink)
    expect(screen.getByTitle('Scan to open FalconDeck')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /open link/i })).not.toBeInTheDocument()
    expect(screen.getByText(/there is no web client/i)).toBeInTheDocument()
  })

  it('shows how long a live pairing code has left', async () => {
    renderPopover()

    fireEvent.click(screen.getByRole('button', { name: /waiting/i }))

    expect(await screen.findByText(/expires in 10:00 · connects one device/i)).toBeInTheDocument()
  })

  it('replaces an expired code with a way to mint a fresh one', async () => {
    const onStartPairing = vi.fn()
    renderPopover(remoteStatus('2026-08-08T11:50:00Z'), onStartPairing)

    fireEvent.click(screen.getByRole('button', { name: /waiting/i }))

    expect(await screen.findByText(/this pairing code expired/i)).toBeInTheDocument()
    // A spent code must not be presented as scannable.
    expect(screen.queryByRole('button', { name: /copy link/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /generate new code/i }))
    expect(onStartPairing).toHaveBeenCalledTimes(1)
  })

  it('counts only live devices as connected and shows last-seen for offline ones', async () => {
    const status: RemoteStatusResponse = {
      ...remoteStatus(),
      status: 'connected',
      pairing: null,
      trusted_devices: [
        {
          device_id: 'device-live',
          session_id: 'session-1',
          label: 'iPhone 17 Pro',
          status: 'active',
          connected: true,
          created_at: '2026-08-01T12:00:00Z',
          last_seen_at: '2026-08-08T11:59:00Z',
          revoked_at: null,
        },
        {
          device_id: 'device-stale',
          session_id: 'session-1',
          label: 'Old iPhone',
          status: 'active',
          connected: false,
          created_at: '2026-07-01T12:00:00Z',
          last_seen_at: '2026-08-01T12:00:00Z',
          revoked_at: null,
        },
      ],
      presence: null,
      last_error: null,
    }
    render(
      <ToastProvider>
        <RemotePairingPopover
          remoteStatus={status}
          pairingLink={null}
          pairingQrValue={null}
          onStartPairing={() => {}}
          isStartingRemote={false}
          remoteControlsDisabled={false}
          remoteControlsUnavailableReason={null}
        />
      </ToastProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /connected/i }))

    expect(await screen.findByText('1 of 2 devices connected')).toBeInTheDocument()
    expect(screen.getByText('iPhone 17 Pro')).toBeInTheDocument()
    expect(screen.getByText('Old iPhone')).toBeInTheDocument()
  })

  it('explains when pairing controls are unavailable', async () => {
    render(
      <ToastProvider>
        <RemotePairingPopover
          remoteStatus={null}
          pairingLink={null}
          pairingQrValue={null}
          onStartPairing={() => {}}
          isStartingRemote={false}
          remoteControlsDisabled
          remoteControlsUnavailableReason="FalconDeck is still connecting."
        />
      </ToastProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /inactive/i }))

    expect(await screen.findByText('FalconDeck is still connecting.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start pairing/i })).toBeDisabled()
  })
})
