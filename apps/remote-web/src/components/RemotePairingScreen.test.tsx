import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RemotePairingScreen } from './RemotePairingScreen'

function renderScreen(overrides: Partial<Parameters<typeof RemotePairingScreen>[0]> = {}) {
  const onConnect = vi.fn()
  const props = {
    relayUrl: 'https://connect.falcondeck.com',
    pairingCode: 'ABCD1234',
    isConnecting: false,
    connectionHelp: null,
    connectionDebugRows: [] as ReadonlyArray<readonly [string, string]>,
    onRelayUrlChange: vi.fn(),
    onPairingCodeChange: vi.fn(),
    onConnect,
    onResetSavedConnection: vi.fn(),
    ...overrides,
  }
  render(<RemotePairingScreen {...props} />)
  return { onConnect, props }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('RemotePairingScreen', () => {
  it('labels the pairing code field', () => {
    renderScreen()
    const field = screen.getByLabelText('Secure pairing code')
    expect(field).toHaveValue('ABCD1234')
    expect(field.closest('.fd-safe-area-padded')).toBeInTheDocument()
  })

  it('submits on Enter from the code field', () => {
    const { onConnect } = renderScreen()
    fireEvent.submit(screen.getByLabelText('Secure pairing code').closest('form')!)
    expect(onConnect).toHaveBeenCalledTimes(1)
  })

  it('uppercases only the human-readable prefix and preserves the authority secret', () => {
    const { props } = renderScreen({ pairingCode: '' })
    fireEvent.change(screen.getByLabelText('Secure pairing code'), {
      target: { value: 'abcd.AbCd_-90' },
    })
    expect(props.onPairingCodeChange).toHaveBeenCalledWith('ABCD.AbCd_-90')
  })

  it('will not submit without a code', () => {
    const { onConnect } = renderScreen({ pairingCode: '   ' })
    const button = screen.getByRole('button', { name: 'Connect' })
    expect(button).toBeDisabled()
    fireEvent.submit(button.closest('form')!)
    expect(onConnect).not.toHaveBeenCalled()
  })

  it('shows progress and blocks a second submit while claiming', () => {
    const { onConnect } = renderScreen({ isConnecting: true })
    const button = screen.getByRole('button', { name: /connecting/i })
    expect(button).toBeDisabled()
    fireEvent.submit(button.closest('form')!)
    expect(onConnect).not.toHaveBeenCalled()
  })

  it('keeps the relay field out of the way until asked for', () => {
    renderScreen()
    expect(screen.queryByLabelText('Relay server URL')).not.toBeInTheDocument()

    const disclosure = screen.getByRole('button', { name: 'Relay server' })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(disclosure)

    expect(screen.getByLabelText('Relay server URL')).toHaveValue('https://connect.falcondeck.com')
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  })
})
