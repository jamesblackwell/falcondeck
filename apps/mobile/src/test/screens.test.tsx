import React from 'react'
import { act } from 'react-test-renderer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const originalConsoleError = console.error

const { routerMock, useRelayStore, useSessionStore, useAppearanceStore } = vi.hoisted(() => {
  ;(globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = false

  const relayState = {
    relayUrl: '',
    pairingCode: '',
    sessionId: null as string | null,
    deviceId: null as string | null,
    clientToken: null as string | null,
    connectionStatus: 'not_connected',
    machinePresence: null as import('@falcondeck/client-core').MachinePresence | null,
    error: null as string | null,
    isConnected: false,
    isEncrypted: false,
    claimPairing: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    _callRpc: vi.fn().mockImplementation(
      (_method: string, params: { notifications?: { enabled?: boolean } }) =>
        Promise.resolve({ notifications: params.notifications }),
    ),
    _getClientToken: () => relayState.clientToken,
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
    navigate: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  }

  // Plain-selector stand-in for the zustand appearance store — the hoisted
  // zustand copy binds to the wrong React instance under react-test-renderer.
  const appearanceState = {
    themeMode: 'system' as const,
    lightColorTheme: 'falcon-light' as const,
    darkColorTheme: 'falcon-dark' as const,
    fontScale: 1,
    setThemeMode: vi.fn(),
    setLightColorTheme: vi.fn(),
    setDarkColorTheme: vi.fn(),
    setFontScale: vi.fn(),
  }
  const appearanceStore = Object.assign(
    <T,>(selector: (state: typeof appearanceState) => T) => selector(appearanceState),
    { getState: () => appearanceState },
  )

  const sessionState = {
    snapshot: {
      preferences: {
        notifications: { enabled: true },
      },
    },
    setPreferences: vi.fn((preferences) => {
      sessionState.snapshot.preferences = preferences
    }),
  }
  const sessionStore = Object.assign(
    <T,>(selector: (state: typeof sessionState) => T) => selector(sessionState),
    { getState: () => sessionState },
  )

  return {
    routerMock,
    useRelayStore: store,
    useSessionStore: sessionStore,
    useAppearanceStore: appearanceStore,
  }
})

vi.mock('expo-router', () => {
  const Stack = ({ children, ...props }: any) => React.createElement('Stack', props, children)
  Stack.Screen = ({ name, options }: any) => React.createElement('StackScreen', { name, options })
  return {
    Redirect: ({ href }: { href: string }) => React.createElement('Redirect', { href }),
    useRouter: () => routerMock,
    useLocalSearchParams: () => ({}),
    Stack,
    Slot: () => null,
    Drawer: ({ children }: any) => children,
  }
})

vi.mock('expo-camera', () => ({
  CameraView: () => null,
  useCameraPermissions: () => [{ granted: true }, vi.fn().mockResolvedValue({ granted: true })],
}))

vi.mock('@/store', () => ({ useRelayStore, useSessionStore }))
vi.mock('@/store/relay-store', () => ({ useRelayStore }))
vi.mock('@/theme/appearance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/theme/appearance')>()),
  useAppearanceStore,
}))

import { cleanup, renderComponent, textOf } from '@/test/render'

import { isPushEnabled, setPushEnabled } from '@/lib/push-notifications'
import IndexScreen from '@/app/index'
import PairScreen from '@/app/(auth)/pair'
import SettingsScreen from '@/app/(app)/settings/index'
import SettingsLayout from '@/app/(app)/settings/_layout'
import ConnectionsSettingsScreen from '@/app/(app)/settings/connections'
import NotificationSettingsScreen from '@/app/(app)/settings/notifications'

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(console, 'error').mockImplementation((message, ...args) => {
    if (
      typeof message === 'string' &&
      (
        message.includes('react-test-renderer is deprecated') ||
        message.includes('The current testing environment is not configured to support act')
      )
    ) {
      return
    }
    originalConsoleError(message, ...args)
  })
})

afterAll(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  cleanup()
  routerMock.push.mockReset()
  routerMock.navigate.mockReset()
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
      clientToken: null,
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
      sessionId: 'session-1',
      connectionStatus: 'connected',
      error: 'Bad pairing code',
    })

    const renderer = renderComponent(<PairScreen />)

    expect(textOf(renderer)).toContain('Connect to your desktop agent')
    expect(textOf(renderer)).toContain('Waiting for desktop…')
    expect(textOf(renderer)).toContain('Bad pairing code')
    expect(routerMock.replace).not.toHaveBeenCalled()
  })

  it('exposes pairing fields and advanced settings to assistive technology', () => {
    const renderer = renderComponent(<PairScreen />)
    const pairingCode = renderer.root.find(
      (node) => node.props.accessibilityLabel === 'Secure pairing code',
    )
    const advanced = renderer.root.find(
      (node) => node.props.accessibilityLabel === 'Self-hosted relay settings',
    )

    expect(pairingCode.props.accessibilityHint).toContain('desktop')
    expect(pairingCode.props.autoCapitalize).toBe('none')
    expect(pairingCode.props.autoCorrect).toBe(false)
    expect(advanced.props.accessibilityRole).toBe('button')
    expect(advanced.props.accessibilityState).toEqual({
      disabled: false,
      expanded: false,
    })

    act(() => {
      advanced.props.onPress()
    })

    expect(renderer.root.find((node) => node.props.accessibilityLabel === 'Relay URL')).toBeTruthy()
    expect(
      renderer.root.find((node) => node.props.accessibilityLabel === 'Self-hosted relay settings').props
        .accessibilityState,
    ).toEqual({ disabled: false, expanded: true })
  })

  it('keeps the demo workspace separate from the pairing controls', () => {
    const renderer = renderComponent(<PairScreen />)
    const text = textOf(renderer)

    expect(text).toContain('Scan QR code')
    expect(text).toContain('or enter the code')
    expect(text).toContain('Just looking around?')
    expect(text).toContain('Explore demo workspace')
  })

  it('enters the demo workspace without pairing', () => {
    const renderer = renderComponent(<PairScreen />)
    const demoButton = renderer.root.find(
      (node) => node.props.label === 'Explore demo workspace',
    )

    act(() => {
      demoButton.props.onPress()
    })

    expect(useRelayStore.getState().sessionId).toBe('demo-session')
    expect(routerMock.replace).toHaveBeenCalledWith('/(app)')
  })

  it('navigates to the app once the session is encrypted', () => {
    useRelayStore.setState({
      relayUrl: 'https://relay.test',
      pairingCode: 'PAIRME',
      sessionId: 'session-1',
      connectionStatus: 'encrypted',
      isEncrypted: true,
    })

    renderComponent(<PairScreen />)

    expect(routerMock.replace).toHaveBeenCalledWith('/(app)')
  })

  it('renders a discoverable settings index', () => {
    useRelayStore.setState({ connectionStatus: 'encrypted', isEncrypted: true })
    const renderer = renderComponent(<SettingsScreen />)
    expect(textOf(renderer)).toContain('Connections')
    expect(textOf(renderer)).toContain('Automations')
    expect(textOf(renderer)).toContain('Appearance')
    expect(textOf(renderer)).toContain('Conversation')
    expect(textOf(renderer)).toContain('Notifications')
    expect(textOf(renderer)).toContain('About FalconDeck')
    renderer.root.findByProps({ accessibilityLabel: 'Automations' }).props.onPress()
    expect(routerMock.push).toHaveBeenCalledWith('/(app)/automations')
  })

  it('renders connection details', () => {
    const disconnect = vi.fn().mockResolvedValue(undefined)
    useRelayStore.setState({
      relayUrl: 'https://relay.test',
      sessionId: 'session-1',
      connectionStatus: 'encrypted',
      isEncrypted: true,
    })
    useRelayStore.getState().disconnect = disconnect

    const renderer = renderComponent(<ConnectionsSettingsScreen />)
    expect(textOf(renderer)).toContain('https://relay.test')
    expect(textOf(renderer)).toContain('End-to-end encrypted')
    expect(textOf(renderer)).toContain('Data sync')
    expect(textOf(renderer)).toContain('Replace connection')
  })

  it('surfaces a connected daemon whose snapshot service is repairing', () => {
    useRelayStore.setState({
      connectionStatus: 'encrypted',
      isEncrypted: true,
      machinePresence: {
        session_id: 'session-1',
        daemon_connected: true,
        daemon_rpc_ready: false,
        last_seen_at: null,
      },
    })

    const index = renderComponent(<SettingsScreen />)
    expect(textOf(index)).toContain('Repairing')
    cleanup()

    const details = renderComponent(<ConnectionsSettingsScreen />)
    expect(textOf(details)).toContain('Repairing sync…')
  })

  it('uses the native stack header for settings', () => {
    const renderer = renderComponent(<SettingsLayout />)
    const stack = renderer.root.findByType('Stack' as any)
    expect(stack.props.screenOptions).toEqual(
      expect.objectContaining({
        headerShown: true,
        headerBackTitle: 'Back',
      }),
    )
    const screens = renderer.root.findAllByType('StackScreen' as any)
    const indexOptions = screens.find((screen) => screen.props.name === 'index')?.props
      .options
    expect(indexOptions).toEqual(
      expect.objectContaining({ title: 'Settings', headerRight: expect.any(Function) }),
    )
    // iOS 26 reserved the large-title row but never painted the label, which
    // left the root looking headerless next to a lone close button.
    expect(indexOptions.headerLargeTitleEnabled).toBeUndefined()
    expect(indexOptions.headerLargeTitle).toBeUndefined()

    // Every child screen must keep a native back button.
    for (const screen of screens) {
      if (screen.props.name === 'index') continue
      expect(screen.props.options?.headerShown).not.toBe(false)
    }
  })

  it('toggles push notifications and syncs the relay registration', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    setPushEnabled(true)

    useRelayStore.setState({
      relayUrl: 'https://relay.test',
      sessionId: 'session-1',
      deviceId: 'device-1',
      clientToken: 'client-token-1',
      connectionStatus: 'encrypted',
      isEncrypted: true,
    })

    const renderer = renderComponent(<NotificationSettingsScreen />)
    expect(textOf(renderer)).toContain('Push notifications')

    const toggle = renderer.root
      .findAllByType('Switch' as any)
      .find((switchNode) => switchNode.props.accessibilityLabel === 'Push notifications')
    if (!toggle) throw new Error('Push notifications switch not found')
    expect(toggle.props.value).toBe(true)
    expect(toggle.props.accessibilityRole).toBe('switch')
    expect(toggle.props.accessibilityLabel).toBe('Push notifications')

    await act(async () => {
      toggle.props.onValueChange(false)
    })

    expect(isPushEnabled()).toBe(false)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://relay.test/v1/sessions/session-1/devices/device-1/push-token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer client-token-1' }),
        body: JSON.stringify({ push_token: null }),
      }),
    )

    await act(async () => {
      toggle.props.onValueChange(true)
      // Registration awaits the push token before POSTing; drain the async
      // chain so the fetch assertion below observes the call.
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(isPushEnabled()).toBe(true)
    // Re-enabling triggers an immediate re-registration on the usable session.
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://relay.test/v1/sessions/session-1/devices/device-1/push-token',
      expect.objectContaining({
        body: JSON.stringify({ push_token: 'ExponentPushToken[test]' }),
      }),
    )
  })
})
