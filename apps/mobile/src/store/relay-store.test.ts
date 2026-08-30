import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
  buildPairingPublicKeyBundle,
  generateBoxKeyPair,
  signPairingAuthorityDaemonBundle,
} from '@falcondeck/client-core'
import { useRelayStore } from './relay-store'
import { useSessionStore } from './session-store'
import {
  isConnectionActionInFlight,
  useConnectionLogStore,
} from './connection-log-store'
import * as SecureStore from 'expo-secure-store'
import { __reset as resetSecureStore } from 'expo-secure-store'
import { __resetAllStores as resetMMKV } from 'react-native-mmkv'

/// Claims are now a two-step challenge → claim flow; mock both relay
/// endpoints so claimPairing can complete.
const TEST_AUTHORITY_SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'

function securePairingCode(code: string) {
  return `${code}.${TEST_AUTHORITY_SECRET}`
}

function mockPairingFetch(claim: Record<string, unknown>) {
  const daemonBundle = claim.daemon_bundle as ReturnType<typeof buildPairingPublicKeyBundle>
  const authority = signPairingAuthorityDaemonBundle(TEST_AUTHORITY_SECRET, daemonBundle)
  const authenticatedClaim = {
    ...claim,
    pairing_authority: {
      public_key: authority.publicKey,
      daemon_bundle_signature: authority.signature,
    },
  }
  return vi.fn().mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.endsWith('/v1/pairings/challenge')) {
      return {
        ok: true,
        json: async () => ({ pairing_id: 'pairing-1', challenge: 'dGVzdC1jaGFsbGVuZ2U=' }),
      }
    }
    return { ok: true, json: async () => authenticatedClaim }
  })
}

function resetStore() {
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
    isSyncing: false,
    hasSyncedOnce: false,
    syncDiagnostics: {
      startedAt: null,
      attempt: 0,
      lastAttemptAt: null,
      nextRetryAt: null,
      lastError: null,
      lastErrorAt: null,
      lastSuccessAt: null,
    },
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

    it('preserves the case-sensitive authority secret', () => {
      useRelayStore.getState().setPairingCode('abcd-1234.AbCd_-90')
      expect(useRelayStore.getState().pairingCode).toBe('ABCD-1234.AbCd_-90')
    })
  })

  describe('sync diagnostics', () => {
    it('tracks attempts and exact retry errors, then clears them on success', () => {
      const store = useRelayStore.getState()
      store._startSyncAttempt()
      store._setSyncRetry('snapshot.current is not registered', Date.now() + 5_000)
      store._startSyncAttempt()

      expect(useRelayStore.getState().syncDiagnostics.attempt).toBe(2)
      expect(useRelayStore.getState().syncDiagnostics.lastError).toBe(
        'snapshot.current is not registered',
      )

      store._setSyncRetry(null, null)
      expect(useRelayStore.getState().syncDiagnostics.nextRetryAt).toBeNull()
      expect(useRelayStore.getState().syncDiagnostics.lastError).toBe(
        'snapshot.current is not registered',
      )

      store._finishSync()
      const finished = useRelayStore.getState()
      expect(finished.isSyncing).toBe(false)
      expect(finished.hasSyncedOnce).toBe(true)
      expect(finished.syncDiagnostics.startedAt).toBeNull()
      expect(finished.syncDiagnostics.lastError).toBeNull()
      expect(finished.syncDiagnostics.lastSuccessAt).not.toBeNull()
    })

    it('starts a reconnect run with fresh timers but remembers the last success', () => {
      const store = useRelayStore.getState()
      store._startSyncAttempt()
      store._finishSync()
      const lastSuccessAt = useRelayStore.getState().syncDiagnostics.lastSuccessAt

      store._startSyncAttempt()
      store._setSyncRetry('Desktop disconnected from the relay.', null)

      store._resetSyncDiagnostics()
      const diagnostics = useRelayStore.getState().syncDiagnostics
      expect(diagnostics.attempt).toBe(0)
      expect(diagnostics.startedAt).toBeNull()
      expect(diagnostics.lastError).toBeNull()
      expect(diagnostics.lastErrorAt).toBeNull()
      expect(diagnostics.nextRetryAt).toBeNull()
      expect(diagnostics.lastSuccessAt).toBe(lastSuccessAt)
    })

    it('times snapshot fetches in the connection log', () => {
      useConnectionLogStore.setState({
        entries: [],
        visible: false,
      })
      const store = useRelayStore.getState()
      store._startSyncAttempt()
      const fetching = useConnectionLogStore.getState().entries.at(-1)
      expect(fetching).toMatchObject({
        message: 'Fetching project list (attempt 1)',
        action: 'snapshot',
      })
      expect(fetching && isConnectionActionInFlight(fetching)).toBe(true)

      store._finishSync()
      const entries = useConnectionLogStore.getState().entries
      const snapshot = entries.find((entry) => entry.action === 'snapshot')
      expect(snapshot && isConnectionActionInFlight(snapshot)).toBe(false)
      expect(entries.at(-1)).toMatchObject({ message: 'Projects synced.' })
    })

    it('times the relay handshake in the connection log', () => {
      useConnectionLogStore.setState({
        entries: [],
        visible: false,
      })
      const store = useRelayStore.getState()
      store._setConnectionStatus('connecting')
      expect(useConnectionLogStore.getState().entries.at(-1)).toMatchObject({
        message: 'Relay: connecting',
        action: 'socket',
      })

      store._setConnectionStatus('connected')
      const entries = useConnectionLogStore.getState().entries
      const socket = entries.find((entry) => entry.action === 'socket')
      expect(socket && isConnectionActionInFlight(socket)).toBe(false)
      expect(entries.at(-1)).toMatchObject({
        message: 'Relay: connected',
        action: 'session-key',
      })

      store._setConnectionStatus('encrypted')
      const keyed = useConnectionLogStore.getState().entries.find(
        (entry) => entry.action === 'session-key',
      )
      expect(keyed && isConnectionActionInFlight(keyed)).toBe(false)
      expect(useConnectionLogStore.getState().entries.at(-1)).toMatchObject({
        message: 'Relay: encrypted',
      })
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

    it('coalesces rapid repeated pairing attempts', async () => {
      const { setRelayUrl, setPairingCode, claimPairing } = useRelayStore.getState()
      setRelayUrl('https://relay.test')
      setPairingCode(securePairingCode('DOUBLE-TAP'))
      const fetchMock = mockPairingFetch({
        pairing_id: 'pairing-1',
        session_id: 'session-one',
        device_id: 'device-one',
        client_token: 'token-one',
        daemon_bundle: buildPairingPublicKeyBundle(generateBoxKeyPair()),
      })
      globalThis.fetch = fetchMock

      await Promise.all([claimPairing(), claimPairing()])

      // One challenge and one claim, not two independent claim flows racing
      // to overwrite the phone's credentials.
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(useRelayStore.getState().sessionId).toBe('session-one')
    })

    it('sets error on network failure', async () => {
      const { setRelayUrl, setPairingCode, claimPairing } = useRelayStore.getState()
      setRelayUrl('https://relay.test')
      setPairingCode(securePairingCode('TEST-CODE'))

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
      setPairingCode(securePairingCode('BAD-CODE'))

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
      setPairingCode(securePairingCode('GOOD-CODE'))

      globalThis.fetch = mockPairingFetch({
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
      })

      await claimPairing()

      const state = useRelayStore.getState()
      expect(state.connectionStatus).toBe('connecting')
      expect(state.sessionId).toBe('session-abc')
      expect(state.deviceId).toBe('device-xyz')
      expect(state.isConnected).toBe(false)
    })

    it('does not adopt relay credentials that the keychain failed to persist', async () => {
      const { setRelayUrl, setPairingCode, claimPairing } = useRelayStore.getState()
      setRelayUrl('https://relay.test')
      setPairingCode(securePairingCode('KEYCHAIN-FAILURE'))
      globalThis.fetch = mockPairingFetch({
        pairing_id: 'pairing-1',
        session_id: 'session-keychain',
        device_id: 'device-keychain',
        client_token: 'token-keychain',
        daemon_bundle: buildPairingPublicKeyBundle(generateBoxKeyPair()),
      })
      vi.spyOn(SecureStore, 'setItemAsync').mockRejectedValueOnce(
        new Error('Keychain is unavailable'),
      )
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

      try {
        await claimPairing()

        expect(useRelayStore.getState()).toMatchObject({
          sessionId: null,
          deviceId: null,
          connectionStatus: 'not_connected',
          error: 'Keychain is unavailable',
        })
      } finally {
        warning.mockRestore()
      }
    })

    it('clears stale encrypted state when claiming a fresh pairing', async () => {
      const { setRelayUrl, setPairingCode, claimPairing, _setSessionCrypto, _getSessionCrypto } =
        useRelayStore.getState()
      setRelayUrl('https://relay.test')
      setPairingCode(securePairingCode('GOOD-CODE'))
      _setSessionCrypto({
        dataKey: new Uint8Array(32),
        material: null,
      })

      globalThis.fetch = mockPairingFetch({
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

    it('clears the relay push token before dropping the client token', async () => {
      const { setRelayUrl, setPairingCode, claimPairing } = useRelayStore.getState()
      setRelayUrl('https://relay.test')
      setPairingCode(securePairingCode('GOOD-CODE'))

      globalThis.fetch = mockPairingFetch({
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
      })
      await claimPairing()

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      })
      globalThis.fetch = fetchMock

      await useRelayStore.getState().disconnect()

      // The best-effort push-token clear must fire while the client token is
      // still available, i.e. it carries the token disconnect is about to drop.
      expect(fetchMock).toHaveBeenCalledWith(
        'https://relay.test/v1/sessions/session-abc/devices/device-xyz/push-token',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ authorization: 'Bearer token-123' }),
          body: JSON.stringify({ push_token: null }),
        }),
      )
    })
  })

  describe('internal helpers', () => {
    it('_setConnectionStatus only marks encryption active when crypto is available', () => {
      const { _setConnectionStatus, _setSessionCrypto } = useRelayStore.getState()

      _setConnectionStatus('encrypted')
      expect(useRelayStore.getState().isEncrypted).toBe(false)
      expect(useRelayStore.getState().isConnected).toBe(true)
      expect(useRelayStore.getState().connectionStatus).toBe('encrypted')

      _setSessionCrypto({
        dataKey: new Uint8Array(32),
        material: null,
      })
      expect(useRelayStore.getState().isEncrypted).toBe(true)

      _setConnectionStatus('connected')
      expect(useRelayStore.getState().isConnected).toBe(true)
      expect(useRelayStore.getState().isEncrypted).toBe(false)

      _setConnectionStatus('connecting')
      expect(useRelayStore.getState().isConnected).toBe(false)
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
