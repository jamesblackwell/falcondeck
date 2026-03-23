import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

function remoteStatus(): RemoteStatusResponse {
  return {
    status: 'pairing_pending',
    relay_url: 'https://connect.falcondeck.com',
    pairing: {
      pairing_id: 'pairing-1',
      pairing_code: 'YMZEYPB2EZTA',
      session_id: null,
      expires_at: '2026-03-23T12:00:00Z',
    },
    trusted_devices: [],
    presence: null,
    last_error: null,
  }
}

function renderPopover() {
  render(
    <ToastProvider>
      <RemotePairingPopover
        remoteStatus={remoteStatus()}
        pairingLink={pairingLink}
        onStartPairing={() => {}}
        onRefreshStatus={() => {}}
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

  it('explains when pairing controls are unavailable', async () => {
    render(
      <ToastProvider>
        <RemotePairingPopover
          remoteStatus={null}
          pairingLink={null}
          onStartPairing={() => {}}
          onRefreshStatus={() => {}}
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
