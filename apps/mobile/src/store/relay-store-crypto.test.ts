/**
 * Tests for relay-store crypto operations — _encryptJson, _decryptJson, _processBootstrap.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import nacl from 'tweetnacl'
import {
  generateBoxKeyPair,
  publicKeyToBase64,
  secretKeyToBase64,
  bytesToBase64,
} from '@falcondeck/client-core'
import type { SessionKeyMaterial, RelayUpdate } from '@falcondeck/client-core'
import { useRelayStore } from './relay-store'
import { __reset as resetSecureStore } from 'expo-secure-store'
import { __resetAllStores as resetMMKV } from 'react-native-mmkv'

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
  })
})
