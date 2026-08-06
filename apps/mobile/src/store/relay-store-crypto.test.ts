/**
 * Tests for relay-store crypto operations — _encryptJson, _decryptJson, _processBootstrap.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  REMOTE_SESSION_STORAGE_VERSION,
  deriveIdentityKeyPair,
  generateBoxKeyPair,
  identityPublicKeyToBase64,
  publicKeyToBase64,
  secretKeyToBase64,
  verifyPairingPublicKeyBundle,
} from '@falcondeck/client-core'
import type { PairingPublicKeyBundle, RelayUpdate } from '@falcondeck/client-core'
import { useRelayStore } from './relay-store'
import { __reset as resetSecureStore } from 'expo-secure-store'
import { __resetAllStores as resetMMKV } from 'react-native-mmkv'
import { getJson, setJson } from '@/storage/mmkv'
import { loadClientToken, persistClientSecretKey, persistClientToken } from '@/storage/secure'

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
  resetSecureStore()
  resetMMKV()
  // disconnect() fires a best-effort push-token clear; keep it off the network.
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
  }) as unknown as typeof fetch
}

describe('relay-store crypto operations', () => {
  beforeEach(resetStore)

  describe('_encryptJson / _decryptJson', () => {
    it('throws when session crypto is not established', async () => {
      const store = useRelayStore.getState()
      // No session crypto set
      await expect(store._encryptJson({ hello: 'world' })).rejects.toThrow('not ready')
    })

    it('round-trips JSON through encrypt/decrypt when crypto is set', async () => {
      const dataKey = crypto.getRandomValues(new Uint8Array(32))
      useRelayStore.getState()._setSessionCrypto({ dataKey, material: null })

      const store = useRelayStore.getState()
      const envelope = await store._encryptJson({ message: 'secret', count: 42 })
      expect(envelope).toBeDefined()
      expect(envelope.ciphertext).toBeTruthy()

      const decrypted = await store._decryptJson<{ message: string; count: number }>(envelope)
      expect(decrypted).toEqual({ message: 'secret', count: 42 })
    })

    it('decrypt throws when session crypto is not established', async () => {
      const store = useRelayStore.getState()
      await expect(store._decryptJson({ ciphertext: 'abc', nonce: 'def' } as any)).rejects.toThrow()
    })
  })

  describe('_processBootstrap', () => {
    it('sets error when bootstrap material does not match local key', async () => {
      // Without a claimPairing call, _getKeyPair returns null,
      // so bootstrap should fail with a clear error.
      const store = useRelayStore.getState()

      const update: RelayUpdate = {
        id: 'u1',
        seq: 1,
        body: {
          t: 'session-bootstrap',
          material: {
            encryption_variant: 'data_key_v1',
            identity_variant: 'ed25519_v1',
            pairing_id: 'pairing-1',
            session_id: 'session-1',
            daemon_public_key: publicKeyToBase64(generateBoxKeyPair()),
            daemon_identity_public_key: publicKeyToBase64(generateBoxKeyPair()),
            client_public_key: publicKeyToBase64(generateBoxKeyPair()),
            client_identity_public_key: publicKeyToBase64(generateBoxKeyPair()),
            client_wrapped_data_key: { encryption_variant: 'data_key_v1', wrapped_key: 'xxx' },
            daemon_wrapped_data_key: null,
            signature: 'sig',
          },
        },
        created_at: new Date().toISOString(),
      }

      await store._processBootstrap(update)
      expect(useRelayStore.getState().error).toBeTruthy()
    })

    it('ignores bootstrap when client key is missing', async () => {
      const store = useRelayStore.getState()

      const update: RelayUpdate = {
        id: 'u1',
        seq: 1,
        body: {
          t: 'session-bootstrap',
          material: {
            encryption_variant: 'data_key_v1',
            identity_variant: 'ed25519_v1',
            pairing_id: 'pairing-1',
            session_id: 'session-1',
            daemon_public_key: 'xxx',
            daemon_identity_public_key: 'zzz',
            client_public_key: 'yyy',
            client_identity_public_key: 'qqq',
            client_wrapped_data_key: { encryption_variant: 'data_key_v1', wrapped_key: 'zzz' },
            daemon_wrapped_data_key: null,
            signature: 'sig',
          },
        },
        created_at: new Date().toISOString(),
      }

      await store._processBootstrap(update)
      // Should set error since no keypair
      expect(useRelayStore.getState().error).toBeTruthy()
    })

    it('ignores non-bootstrap updates', async () => {
      const store = useRelayStore.getState()
      const update: RelayUpdate = {
        id: 'u1',
        seq: 1,
        body: {
          t: 'presence',
          presence: { session_id: 's1', daemon_connected: true, last_seen_at: null },
        },
        created_at: new Date().toISOString(),
      }

      await store._processBootstrap(update)
      // Should not change encryption state
      expect(useRelayStore.getState().isEncrypted).toBe(false)
    })

    it('keeps the pairing intact when an addressed bootstrap fails verification', async () => {
      // A malformed durable bootstrap replayed by a buggy or compromised
      // relay must not unpair the device — only surface an error and skip.
      const kp = generateBoxKeyPair()
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
      await persistClientSecretKey(secretKeyToBase64(kp))
      await persistClientToken('token-abc')
      expect(await useRelayStore.getState().restoreSession()).toBe(true)

      const update: RelayUpdate = {
        id: 'u1',
        seq: 11,
        body: {
          t: 'session-bootstrap',
          material: {
            encryption_variant: 'data_key_v1',
            identity_variant: 'ed25519_v1',
            pairing_id: 'pairing-1',
            session_id: 'session-1',
            daemon_public_key: 'daemon-public-key',
            daemon_identity_public_key: 'daemon-identity-key',
            // Addressed to this client so processing reaches verification…
            client_public_key: publicKeyToBase64(kp),
            client_identity_public_key: identityPublicKeyToBase64(deriveIdentityKeyPair(kp)),
            client_wrapped_data_key: { encryption_variant: 'data_key_v1', wrapped_key: 'xxx' },
            daemon_wrapped_data_key: null,
            // …which fails on the bogus signature.
            signature: 'sig',
          },
        },
        created_at: new Date().toISOString(),
      }

      await useRelayStore.getState()._processBootstrap(update)

      const state = useRelayStore.getState()
      expect(state.error).toBeTruthy()
      // The session, key pair, secure storage, and persisted session survive.
      expect(state.sessionId).toBe('session-1')
      expect(state.connectionStatus).not.toBe('not_connected')
      expect(state._getKeyPair()).not.toBeNull()
      expect(getJson('relay.session')).not.toBeNull()
      await expect(loadClientToken()).resolves.toBe('token-abc')
    })
  })

  describe('_requestBootstrap', () => {
    // Restores a trusted session that kept its key pair and client token but
    // lost the session data key — the state data-key recovery targets.
    async function restoreKeylessSession(kp = generateBoxKeyPair()) {
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
      await persistClientSecretKey(secretKeyToBase64(kp))
      await persistClientToken('token-abc')
      expect(await useRelayStore.getState().restoreSession()).toBe(true)
      return kp
    }

    function captureSentMessages() {
      const sent: unknown[] = []
      useRelayStore.setState({
        _sendMessage: (message) => {
          sent.push(message)
        },
      })
      return sent
    }

    it('sends a request-bootstrap ephemeral when the session key is missing', async () => {
      await useRelayStore.getState().disconnect()
      const kp = await restoreKeylessSession()
      const sent = captureSentMessages()

      expect(useRelayStore.getState()._requestBootstrap()).toBe(true)

      expect(sent).toHaveLength(1)
      const message = sent[0] as {
        type: string
        body: { kind: string; device_id: string; client_bundle: PairingPublicKeyBundle }
      }
      expect(message.type).toBe('ephemeral')
      expect(message.body.kind).toBe('request-bootstrap')
      expect(message.body.device_id).toBe('device-1')
      // The bundle is rebuilt from the persisted key pair and properly signed.
      expect(message.body.client_bundle.public_key).toBe(publicKeyToBase64(kp))
      expect(() => verifyPairingPublicKeyBundle(message.body.client_bundle)).not.toThrow()
    })

    it('does not request a bootstrap when session crypto is already present', async () => {
      await useRelayStore.getState().disconnect()
      await restoreKeylessSession()
      useRelayStore.getState()._setSessionCrypto({
        dataKey: crypto.getRandomValues(new Uint8Array(32)),
        material: null,
      })
      const sent = captureSentMessages()

      expect(useRelayStore.getState()._requestBootstrap()).toBe(false)
      expect(sent).toHaveLength(0)
    })

    it('does not request a bootstrap without a local key pair', async () => {
      await useRelayStore.getState().disconnect()
      const sent = captureSentMessages()

      expect(useRelayStore.getState()._requestBootstrap()).toBe(false)
      expect(sent).toHaveLength(0)
    })

    it('returns false when the socket send fails so the caller can retry', async () => {
      await useRelayStore.getState().disconnect()
      await restoreKeylessSession()
      useRelayStore.setState({
        _sendMessage: () => {
          throw new Error('Remote connection is not ready')
        },
      })

      expect(useRelayStore.getState()._requestBootstrap()).toBe(false)
    })
  })
})
