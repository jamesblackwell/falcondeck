import { describe, it, expect, beforeEach, vi } from 'vitest'

import { buildPairingPublicKeyBundle, generateBoxKeyPair } from '@falcondeck/client-core'
import { useRelayStore } from './relay-store'
import { useSessionStore } from './session-store'
import { __reset as resetSecureStore } from 'expo-secure-store'
import { __resetAllStores as resetMMKV } from 'react-native-mmkv'

function resetStore() {
  // Reset internal refs by disconnecting
  const state = useRelayStore.getState()
  // Force reset internal state
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
  useSessionStore.getState().reset()
  resetSecureStore()
  resetMMKV()
}

describe('relay-store', () => {
  beforeEach(resetStore)

  describe('initial state', () => {
    it('starts not connected with no session', () => {
      const state = useRelayStore.getState()
      expect(state.connectionStatus).toBe('not_connected')
      expect(state.sessionId).toBeNull()
      expect(state.deviceId).toBeNull()
      expect(state.isConnected).toBe(false)
      expect(state.isEncrypted).toBe(false)
      expect(state.error).toBeNull()
    })
  })

  describe('setRelayUrl / setPairingCode', () => {
    it('stores the relay URL', () => {
      useRelayStore.getState().setRelayUrl('https://custom.relay.com')
      expect(useRelayStore.getState().relayUrl).toBe('https://custom.relay.com')
    })

    it('uppercases the pairing code', () => {
      useRelayStore.getState().setPairingCode('abcd-1234')
      expect(useRelayStore.getState().pairingCode).toBe('ABCD-1234')
    })
  })

  describe('claimPairing', () => {
    it('does nothing when relay URL or pairing code is empty', async () => {
      const { claimPairing } = useRelayStore.getState()

      // Both empty
      await claimPairing()
      expect(useRelayStore.getState().connectionStatus).toBe('not_connected')

      // URL set, code empty
      useRelayStore.getState().setRelayUrl('https://relay.test')
      await claimPairing()
      expect(useRelayStore.getState().connectionStatus).toBe('not_connected')
    })

    it('sets error on network failure', async () => {
      const { setRelayUrl, setPairingCode, claimPairing } = useRelayStore.getState()
      setRelayUrl('https://relay.test')
      setPairingCode('TEST-CODE')

      // Mock fetch to fail
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'))

      await claimPairing()

      const state = useRelayStore.getState()
      expect(state.connectionStatus).toBe('not_connected')
      expect(state.error).toBe('Network error')
    })

    it('sets error on non-OK response', async () => {
      const { setRelayUrl, setPairingCode, claimPairing } = useRelayStore.getState()
      setRelayUrl('https://relay.test')
      setPairingCode('BAD-CODE')

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Pairing not found' }),
      })

      await claimPairing()

      const state = useRelayStore.getState()
      expect(state.connectionStatus).toBe('not_connected')
      expect(state.error).toBe('Pairing not found')
    })

    it('transitions to connecting on successful claim', async () => {
      const { setRelayUrl, setPairingCode, claimPairing } = useRelayStore.getState()
      setRelayUrl('https://relay.test')
      setPairingCode('GOOD-CODE')

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          pairing_id: 'pairing-1',
          session_id: 'session-abc',
          device_id: 'device-xyz',
          client_token: 'token-123',
          trusted_device: {
            device_id: 'device-xyz',
            session_id: 'session-abc',
            label: 'FalconDeck iPhone',
            status: 'active',
            created_at: '2026-03-16T10:00:00Z',
            last_seen_at: '2026-03-16T10:00:00Z',
            revoked_at: null,
          },
          daemon_bundle: buildPairingPublicKeyBundle(generateBoxKeyPair()),
        }),
      })

      await claimPairing()

      const state = useRelayStore.getState()
      expect(state.connectionStatus).toBe('connecting')
      expect(state.sessionId).toBe('session-abc')
      expect(state.deviceId).toBe('device-xyz')
      expect(state.isConnected).toBe(true)
    })

    it('clears stale encrypted state when claiming a fresh pairing', async () => {
      const { setRelayUrl, setPairingCode, claimPairing, _setSessionCrypto, _getSessionCrypto } =
        useRelayStore.getState()
      setRelayUrl('https://relay.test')
      setPairingCode('GOOD-CODE')
      _setSessionCrypto({
        dataKey: new Uint8Array(32),
        material: null,
      })

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          pairing_id: 'pairing-1',
          session_id: 'session-abc',
          device_id: 'device-xyz',
          client_token: 'token-123',
          trusted_device: {
            device_id: 'device-xyz',
            session_id: 'session-abc',
            label: 'FalconDeck iPhone',
            status: 'active',
            created_at: '2026-03-16T10:00:00Z',
            last_seen_at: '2026-03-16T10:00:00Z',
            revoked_at: null,
          },
          daemon_bundle: buildPairingPublicKeyBundle(generateBoxKeyPair()),
        }),
      })

      await claimPairing()

      expect(useRelayStore.getState().isEncrypted).toBe(false)
      expect(_getSessionCrypto()).toBeNull()
    })
  })

  describe('disconnect', () => {
    it('resets all state and clears storage', async () => {
      // Simulate a connected state
      useRelayStore.setState({
        sessionId: 'session-1',
        deviceId: 'device-1',
        connectionStatus: 'encrypted',
        isConnected: true,
        isEncrypted: true,
      })

      await useRelayStore.getState().disconnect()

      const state = useRelayStore.getState()
      expect(state.sessionId).toBeNull()
      expect(state.deviceId).toBeNull()
      expect(state.connectionStatus).toBe('not_connected')
      expect(state.isConnected).toBe(false)
      expect(state.isEncrypted).toBe(false)
    })
  })

  describe('internal helpers', () => {
    it('_setConnectionStatus only marks encryption active when crypto is available', () => {
      const { _setConnectionStatus, _setSessionCrypto } = useRelayStore.getState()

      _setConnectionStatus('encrypted')
      expect(useRelayStore.getState().isEncrypted).toBe(false)
      expect(useRelayStore.getState().connectionStatus).toBe('encrypted')

      _setSessionCrypto({
        dataKey: new Uint8Array(32),
        material: null,
      })
      expect(useRelayStore.getState().isEncrypted).toBe(true)

      _setConnectionStatus('connected')
      expect(useRelayStore.getState().isEncrypted).toBe(false)
    })

    it('_setMachinePresence updates presence', () => {
      useRelayStore.getState()._setMachinePresence({
        session_id: 's1',
        daemon_connected: true,
        last_seen_at: '2026-03-16T10:00:00Z',
      })

      expect(useRelayStore.getState().machinePresence?.daemon_connected).toBe(true)
    })

    it('_setLastReceivedSeq tracks the high-water mark', () => {
      const store = useRelayStore.getState()
      store._setLastReceivedSeq(5)
      expect(store._getLastReceivedSeq()).toBe(5)

      store._setLastReceivedSeq(3) // lower seq should be ignored
      expect(store._getLastReceivedSeq()).toBe(5)

      store._setLastReceivedSeq(10)
      expect(store._getLastReceivedSeq()).toBe(10)
    })

    it('_setError sets and clears error', () => {
      const store = useRelayStore.getState()
      store._setError('Something broke')
      expect(useRelayStore.getState().error).toBe('Something broke')

      store._setError(null)
      expect(useRelayStore.getState().error).toBeNull()
    })
  })
})
