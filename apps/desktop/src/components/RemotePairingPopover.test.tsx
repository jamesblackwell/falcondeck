import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RemoteStatusResponse } from '@falcondeck/client-core'
import { ToastProvider } from '@falcondeck/ui'

import { openExternalUrl } from '../api'
import { RemotePairingPopover } from './RemotePairingPopover'

type MockButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  children?: React.ReactNode
}

type MockCopyButtonProps = {
  text: string
  className?: string
  label?: string
}

vi.mock('../api', () => ({
  openExternalUrl: vi.fn(),
}))

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

const openExternalUrlMock = vi.mocked(openExternalUrl)

const pairingLink = 'https://app.falcondeck.com?code=YMZEYPB2EZTA'

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
    openExternalUrlMock.mockReset()
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens the pairing link via the desktop bridge', async () => {
    renderPopover()

    fireEvent.click(screen.getByRole('button', { name: /waiting/i }))
    expect(await screen.findByRole('button', { name: /copy link/i })).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /open link/i }))

    await waitFor(() => {
      expect(openExternalUrlMock).toHaveBeenCalledWith(pairingLink)
    })
  })

  it('shows a toast when opening the pairing link fails', async () => {
    openExternalUrlMock.mockRejectedValue(new Error('Browser launch failed'))

    renderPopover()

    fireEvent.click(screen.getByRole('button', { name: /waiting/i }))
    fireEvent.click(await screen.findByRole('button', { name: /open link/i }))

    expect(await screen.findByText('Failed to open link')).toBeInTheDocument()
    expect(await screen.findByText('Browser launch failed')).toBeInTheDocument()
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
    expect(screen.queryByRole('button', { name: /open link/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /generate new code/i }))
    expect(onStartPairing).toHaveBeenCalledTimes(1)
  })

  it('explains when pairing controls are unavailable', async () => {
    render(
      <ToastProvider>
        <RemotePairingPopover
          remoteStatus={null}
          pairingLink={null}
          onStartPairing={() => {}}
          isStartingRemote={false}
          remoteControlsDisabled
          remoteControlsUnavailableReason="FalconDeck is still connecting to the local daemon."
        />
      </ToastProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /inactive/i }))

    expect(await screen.findByText('FalconDeck is still connecting to the local daemon.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start pairing/i })).toBeDisabled()
  })
})
