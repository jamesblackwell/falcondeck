/**
 * Edge case tests for relay-store — restoreSession, persistence, seq tracking.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
  REMOTE_SESSION_STORAGE_VERSION,
  buildPairingPublicKeyBundle,
  generateBoxKeyPair,
  secretKeyToBase64,
  bytesToBase64,
} from '@falcondeck/client-core'
import { useRelayStore } from './relay-store'
import { useSessionStore } from './session-store'
import { __reset as resetSecureStore } from 'expo-secure-store'
import { __resetAllStores as resetMMKV } from 'react-native-mmkv'
import { setJson, getJson } from '@/storage/mmkv'
import {
  persistClientSecretKey,
  persistDataKey,
  persistClientToken,
} from '@/storage/secure'

function resetStore() {
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

describe('relay-store edge cases', () => {
  beforeEach(resetStore)

  describe('restoreSession', () => {
    it('returns false when no persisted session exists', async () => {
      const result = await useRelayStore.getState().restoreSession()
      expect(result).toBe(false)
      expect(useRelayStore.getState().connectionStatus).toBe('not_connected')
    })

    it('returns false when MMKV has session but SecureStore missing keys', async () => {
      setJson('relay.session', {
        version: REMOTE_SESSION_STORAGE_VERSION,
        relayUrl: 'https://relay.test',
        pairingCode: 'CODE-123',
        pairingId: 'pairing-1',
        sessionId: 'session-1',
        deviceId: 'device-1',
        daemonPublicKey: 'daemon-public-key',
        daemonIdentityPublicKey: 'daemon-identity-key',
        lastReceivedSeq: 5,
      })
      // SecureStore has no keys

      const result = await useRelayStore.getState().restoreSession()
      expect(result).toBe(false)
      // Should clean up the stale MMKV entry
      expect(getJson('relay.session')).toBeNull()
    })

    it('restores session when all persisted data is present', async () => {
      const kp = generateBoxKeyPair()
      const secretB64 = secretKeyToBase64(kp)

      setJson('relay.session', {
        version: REMOTE_SESSION_STORAGE_VERSION,
        relayUrl: 'https://relay.test',
        pairingCode: 'CODE-123',
        pairingId: 'pairing-1',
        sessionId: 'session-1',
        deviceId: 'device-1',
        daemonPublicKey: 'daemon-public-key',
        daemonIdentityPublicKey: 'daemon-identity-key',
        lastReceivedSeq: 10,
      })

      await persistClientSecretKey(secretB64)
      await persistClientToken('token-abc')

      const result = await useRelayStore.getState().restoreSession()
      expect(result).toBe(true)

      const state = useRelayStore.getState()
      expect(state.relayUrl).toBe('https://relay.test')
      expect(state.pairingCode).toBe('CODE-123')
      expect(state.sessionId).toBe('session-1')
      expect(state.deviceId).toBe('device-1')
      expect(state.connectionStatus).toBe('connecting')
      expect(state.isConnected).toBe(false)
    })

    it('returns false when secret key is corrupt (catch branch)', async () => {
      setJson('relay.session', {
        version: REMOTE_SESSION_STORAGE_VERSION,
        relayUrl: 'https://relay.test',
        pairingCode: 'CODE-123',
        pairingId: 'pairing-1',
        sessionId: 'session-1',
        deviceId: 'device-1',
        daemonPublicKey: 'daemon-public-key',
        daemonIdentityPublicKey: 'daemon-identity-key',
        lastReceivedSeq: 5,
      })

      // Persist a corrupt secret key that will fail restoreBoxKeyPair
      await persistClientSecretKey('not-a-valid-base64-nacl-key!!!')
      await persistClientToken('token-abc')

      const result = await useRelayStore.getState().restoreSession()
      expect(result).toBe(false)
    })

    it('restores saved crypto without marking the session encrypted yet', async () => {
      const kp = generateBoxKeyPair()
      const secretB64 = secretKeyToBase64(kp)
      const dataKey = crypto.getRandomValues(new Uint8Array(32))
      const dataKeyB64 = bytesToBase64(dataKey)

      setJson('relay.session', {
        version: REMOTE_SESSION_STORAGE_VERSION,
        relayUrl: 'https://relay.test',
        pairingCode: 'CODE-123',
        pairingId: 'pairing-1',
        sessionId: 'session-1',
        deviceId: 'device-1',
        daemonPublicKey: 'daemon-public-key',
        daemonIdentityPublicKey: 'daemon-identity-key',
        lastReceivedSeq: 10,
      })

      await persistClientSecretKey(secretB64)
      await persistClientToken('token-abc')
      await persistDataKey(dataKeyB64)

      const result = await useRelayStore.getState().restoreSession()
      expect(result).toBe(true)
      const state = useRelayStore.getState()
      expect(state.connectionStatus).toBe('connecting')
      expect(state.isEncrypted).toBe(false)
      expect(state._getSessionCrypto()).not.toBeNull()
    })
  })

  describe('_persistSession', () => {
    it('persists current session state to MMKV', async () => {
      const daemonBundle = buildPairingPublicKeyBundle(generateBoxKeyPair())
      useRelayStore.getState().setRelayUrl('https://relay.test')
      useRelayStore.getState().setPairingCode('ABCD')
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          pairing_id: 'pairing-1',
          session_id: 'session-xyz',
          device_id: 'device-123',
          client_token: 'token-xyz',
          trusted_device: {
            device_id: 'device-123',
            session_id: 'session-xyz',
            label: 'FalconDeck iPhone',
            status: 'active',
            created_at: '2026-03-16T10:00:00Z',
            last_seen_at: '2026-03-16T10:00:00Z',
            revoked_at: null,
          },
          daemon_bundle: daemonBundle,
        }),
      })

      await useRelayStore.getState().claimPairing()
      useRelayStore.getState()._persistSession()

      const persisted = getJson<any>('relay.session')
      expect(persisted).toBeTruthy()
      expect(persisted.version).toBe(REMOTE_SESSION_STORAGE_VERSION)
      expect(persisted.sessionId).toBe('session-xyz')
      expect(persisted.pairingCode).toBe('ABCD')
    })

    it('skips persist when sessionId is null', () => {
      // Verify that calling _persistSession with null sessionId
      // doesn't overwrite a missing key (it guards with if !sessionId return)
      useRelayStore.setState({
        relayUrl: 'https://relay.test',
        pairingCode: 'ABCD',
        sessionId: null,
        deviceId: null,
      })

      // First clear MMKV so there's nothing to find
      resetMMKV()
      useRelayStore.getState()._persistSession()

      // Nothing should have been written
      expect(getJson('relay.session')).toBeNull()
    })
  })

  describe('_setLastReceivedSeq high-water mark', () => {
    it('only increases, never decreases', () => {
      const store = useRelayStore.getState()

      // Note: _lastReceivedSeq is a module-level variable that may have
      // been set by prior tests. We test relative behavior, not absolute values.
      const baseline = store._getLastReceivedSeq()

      store._setLastReceivedSeq(baseline + 10)
      expect(store._getLastReceivedSeq()).toBe(baseline + 10)

      store._setLastReceivedSeq(baseline + 5) // lower — should be ignored
      expect(store._getLastReceivedSeq()).toBe(baseline + 10)

      store._setLastReceivedSeq(baseline + 10) // same — should stay
      expect(store._getLastReceivedSeq()).toBe(baseline + 10)

      store._setLastReceivedSeq(baseline + 100)
      expect(store._getLastReceivedSeq()).toBe(baseline + 100)
    })
  })

  describe('_sendMessage without socket', () => {
    it('throws a clear error when no socket is set', () => {
      expect(() => {
        useRelayStore.getState()._sendMessage({ type: 'ping' })
      }).toThrow('Remote connection is not ready')
    })

    it('_getSocket returns null when not connected', () => {
      expect(useRelayStore.getState()._getSocket()).toBeNull()
    })
  })

  describe('_setSessionCrypto', () => {
    it('does not mark the session encrypted before the transport is encrypted', () => {
      useRelayStore.getState()._setSessionCrypto({
        dataKey: new Uint8Array(32),
        material: null,
      })
      expect(useRelayStore.getState().isEncrypted).toBe(false)
    })

    it('marks the session encrypted only when crypto and encrypted status are both present', () => {
      const store = useRelayStore.getState()
      store._setSessionCrypto({
        dataKey: new Uint8Array(32),
        material: null,
      })
      store._setConnectionStatus('encrypted')
      expect(useRelayStore.getState().isEncrypted).toBe(true)
    })

    it('clears isEncrypted when crypto is null', () => {
      const store = useRelayStore.getState()
      store._setSessionCrypto({
        dataKey: new Uint8Array(32),
        material: null,
      })
      store._setConnectionStatus('encrypted')
      expect(useRelayStore.getState().isEncrypted).toBe(true)

      store._setSessionCrypto(null)
      expect(useRelayStore.getState().isEncrypted).toBe(false)
    })
  })

  describe('claimPairing fetch payload', () => {
    it('sends correct POST body with public key', async () => {
      const { setRelayUrl, setPairingCode, claimPairing } = useRelayStore.getState()
      setRelayUrl('https://relay.test')
      setPairingCode('TEST-CODE')

      let capturedBody: any = null
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body)
        const daemonBundle = buildPairingPublicKeyBundle(generateBoxKeyPair())
        return {
          ok: true,
          json: async () => ({
            pairing_id: 'pairing-1',
            session_id: 'session-1',
            device_id: 'device-1',
            client_token: 'token-1',
            trusted_device: {
              device_id: 'device-1',
              session_id: 'session-1',
              label: 'FalconDeck iPhone',
              status: 'active',
              created_at: '2026-03-16T10:00:00Z',
              last_seen_at: '2026-03-16T10:00:00Z',
              revoked_at: null,
            },
            daemon_bundle: daemonBundle,
          }),
        }
      })

      await claimPairing()

      expect(capturedBody).toBeTruthy()
      expect(capturedBody.pairing_code).toBe('TEST-CODE')
      expect(capturedBody.label).toBe('FalconDeck iPhone')
      expect(capturedBody.client_bundle.encryption_variant).toBe('data_key_v1')
      expect(capturedBody.client_bundle.identity_variant).toBe('ed25519_v1')
      expect(typeof capturedBody.client_bundle.identity_public_key).toBe('string')
      expect(typeof capturedBody.client_bundle.public_key).toBe('string')
      expect(typeof capturedBody.client_bundle.signature).toBe('string')
      expect(capturedBody.client_bundle.public_key.length).toBeGreaterThan(0)
    })

    it('POSTs to the correct endpoint', async () => {
      const { setRelayUrl, setPairingCode, claimPairing } = useRelayStore.getState()
      setRelayUrl('https://relay.test/')
      setPairingCode('CODE')

      let capturedUrl: string = ''
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        capturedUrl = url
        const daemonBundle = buildPairingPublicKeyBundle(generateBoxKeyPair())
        return {
          ok: true,
          json: async () => ({
            pairing_id: 'pairing-1',
            session_id: 's1',
            device_id: 'd1',
            client_token: 't1',
            trusted_device: {
              device_id: 'd1',
              session_id: 's1',
              label: 'FalconDeck iPhone',
              status: 'active',
              created_at: '2026-03-16T10:00:00Z',
              last_seen_at: '2026-03-16T10:00:00Z',
              revoked_at: null,
            },
            daemon_bundle: daemonBundle,
          }),
        }
      })

      await claimPairing()
      expect(capturedUrl).toBe('https://relay.test/v1/pairings/claim')
    })
  })

  describe('disconnect cleanup', () => {
    it('clears all state including machine presence', async () => {
      useSessionStore.setState({
        snapshot: {} as any,
        selectedWorkspaceId: 'workspace-1',
        selectedThreadId: 'thread-1',
        threadItems: { 'thread-1': [] },
        threadDetail: null,
      })
      useRelayStore.setState({
        sessionId: 'session-1',
        deviceId: 'device-1',
        connectionStatus: 'encrypted',
        isConnected: true,
        isEncrypted: true,
        machinePresence: {
          session_id: 'session-1',
          daemon_connected: true,
          last_seen_at: '2026-03-16T10:00:00Z',
        },
        error: 'old error',
      })

      await useRelayStore.getState().disconnect()

      const state = useRelayStore.getState()
      expect(state.machinePresence).toBeNull()
      expect(state.error).toBeNull()
      expect(state.connectionStatus).toBe('not_connected')
      expect(state.isConnected).toBe(false)
      expect(state.isEncrypted).toBe(false)
      expect(useSessionStore.getState().snapshot).toBeNull()
      expect(useSessionStore.getState().threadItems).toEqual({})
    })
  })
})
