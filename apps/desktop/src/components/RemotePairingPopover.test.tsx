import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RemoteStatusResponse } from '@falcondeck/client-core'
import { ToastProvider } from '@falcondeck/ui'

import { openExternalUrl } from '../api'
import { RemotePairingPopover } from './RemotePairingPopover'

vi.mock('../api', () => ({
  openExternalUrl: vi.fn(),
}))

vi.mock('@falcondeck/ui', async () => {
  const actual = await vi.importActual<typeof import('@falcondeck/ui')>('@falcondeck/ui')

  return {
    ...actual,
    Button: ({ children, ...props }: any) => (
      <button {...props}>{children}</button>
    ),
    CopyButton: ({ text, className, label = 'Copy' }: any) => (
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
})
