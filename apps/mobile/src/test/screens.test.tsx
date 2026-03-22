import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { routerMock, useRelayStore } = vi.hoisted(() => {
  ;(globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = false

  const relayState = {
    relayUrl: '',
    pairingCode: '',
    sessionId: null as string | null,
    deviceId: null as string | null,
    connectionStatus: 'not_connected',
    machinePresence: null,
    error: null as string | null,
    isConnected: false,
    isEncrypted: false,
    claimPairing: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  }

  const store = Object.assign(
    <T,>(selector: (state: typeof relayState) => T) => selector(relayState),
    {
      getState: () => relayState,
      setState: (partial: Partial<typeof relayState>) => {
        Object.assign(relayState, partial)
      },
    },
  )

  const routerMock = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  }

  return { routerMock, useRelayStore: store }
})

vi.mock('expo-router', () => {
  return {
    Redirect: ({ href }: { href: string }) => React.createElement('Redirect', { href }),
    useRouter: () => routerMock,
    useLocalSearchParams: () => ({}),
    Stack: ({ children }: any) => children,
    Slot: () => null,
    Drawer: ({ children }: any) => children,
  }
})

vi.mock('expo-camera', () => ({
  CameraView: () => null,
  useCameraPermissions: () => [{ granted: true }, vi.fn().mockResolvedValue({ granted: true })],
}))

vi.mock('@/store', () => ({ useRelayStore }))
vi.mock('@/store/relay-store', () => ({ useRelayStore }))

import { cleanup, renderComponent, textOf } from '@/test/render'

import IndexScreen from '@/app/index'
import PairScreen from '@/app/(auth)/pair'
import SettingsScreen from '@/app/(app)/settings/index'

afterEach(() => {
  cleanup()
  routerMock.push.mockReset()
  routerMock.replace.mockReset()
  routerMock.back.mockReset()
})

describe('mobile app screens', () => {
  const originalClaimPairing = useRelayStore.getState().claimPairing
  const originalDisconnect = useRelayStore.getState().disconnect

  beforeEach(() => {
    useRelayStore.setState({
      relayUrl: 'https://connect.falcondeck.com',
      pairingCode: '',
      sessionId: null,
      deviceId: null,
      connectionStatus: 'not_connected',
      machinePresence: null,
      error: null,
      isConnected: false,
      isEncrypted: false,
    })
    useRelayStore.getState().claimPairing = originalClaimPairing
    useRelayStore.getState().disconnect = originalDisconnect
  })

  it('redirects to pairing when no session exists and to app when it does', () => {
    const unauthenticated = renderComponent(<IndexScreen />)
    expect(unauthenticated.root.findByType('Redirect' as any).props.href).toBe('/(auth)/pair')

    useRelayStore.setState({ sessionId: 'session-1' })
    const authenticated = renderComponent(<IndexScreen />)
    expect(authenticated.root.findByType('Redirect' as any).props.href).toBe('/(app)')
  })

  it('renders the pairing screen and navigates after connection', () => {
    useRelayStore.setState({
      relayUrl: 'https://relay.test',
      pairingCode: 'PAIRME',
      connectionStatus: 'claiming',
      error: 'Bad pairing code',
      isConnected: true,
    })

    const renderer = renderComponent(<PairScreen />)

    expect(textOf(renderer)).toContain('Connect to your desktop agent')
    expect(textOf(renderer)).toContain('Bad pairing code')
    expect(routerMock.replace).toHaveBeenCalledWith('/(app)')
  })

  it('renders settings and disconnects back to pairing', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined)
    useRelayStore.setState({
      relayUrl: 'https://relay.test',
      sessionId: 'session-1',
      connectionStatus: 'encrypted',
      isEncrypted: true,
    })
    useRelayStore.getState().disconnect = disconnect

    const renderer = renderComponent(<SettingsScreen />)
    expect(textOf(renderer)).toContain('Settings')
    expect(textOf(renderer)).toContain('https://relay.test')
    expect(textOf(renderer)).toContain('Relay session encrypted')

    const disconnectButton = renderer.root.find(
      (node) => node.props.label === 'Disconnect' && typeof node.props.onPress === 'function',
    )
    await act(async () => {
      await disconnectButton.props.onPress()
    })

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(routerMock.replace).toHaveBeenCalledWith('/(auth)/pair')
  })
})
