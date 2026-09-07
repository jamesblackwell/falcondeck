import nacl from 'tweetnacl'
import {
  buildPairingPublicKeyBundle, bytesToBase64, deriveIdentityKeyPair,
  generateBoxKeyPair, REMOTE_SESSION_STORAGE_VERSION, secretKeyToBase64,
  type RelayUpdate, type SessionKeyMaterial,
} from '@falcondeck/client-core'
import { setJson } from '@/storage/mmkv'
import { clearDataKey, persistClientSecretKey, persistClientToken, persistDataKey } from '@/storage/secure'
import { useRelayStore } from '@/store/relay-store'

// Real signed/NaCl-wrapped bootstrap material, not a stub of the verifier.
// Keep independent key bytes: the store zeroes the keys it owns on teardown.
export async function restoreTestRelaySession(savedKey: Uint8Array | null = new Uint8Array(32).fill(13)) {
  const phone = generateBoxKeyPair()
  const daemon = generateBoxKeyPair()
  const phoneBundle = buildPairingPublicKeyBundle(phone)
  const daemonBundle = buildPairingPublicKeyBundle(daemon)
  const dataKey = new Uint8Array(32).fill(42)
  const persisted = {
    version: REMOTE_SESSION_STORAGE_VERSION, relayUrl: 'https://relay.test',
    pairingCode: '', pairingId: 'pairing', sessionId: 'session', deviceId: 'phone',
    daemonPublicKey: daemonBundle.public_key,
    daemonIdentityPublicKey: daemonBundle.identity_public_key, lastReceivedSeq: 10,
  }
  await persistClientSecretKey(secretKeyToBase64(phone))
  await persistClientToken('test-token')
  if (savedKey) await persistDataKey(bytesToBase64(savedKey))
  else await clearDataKey()
  setJson('relay.session', persisted)
  if (!await useRelayStore.getState().restoreSession()) throw new Error('test session did not restore')

  function bootstrap(seq = 11, overrides: Partial<SessionKeyMaterial> = {}): RelayUpdate {
    const ephemeral = nacl.box.keyPair()
    const nonce = nacl.randomBytes(24)
    const wrapped = nacl.box(dataKey, nonce, phone.publicKey, ephemeral.secretKey)
    const material: SessionKeyMaterial = {
      encryption_variant: 'data_key_v1', identity_variant: 'ed25519_v1',
      pairing_id: persisted.pairingId, session_id: persisted.sessionId,
      daemon_public_key: daemonBundle.public_key,
      daemon_identity_public_key: daemonBundle.identity_public_key,
      client_public_key: phoneBundle.public_key,
      client_identity_public_key: phoneBundle.identity_public_key,
      client_wrapped_data_key: { encryption_variant: 'data_key_v1', wrapped_key:
        bytesToBase64(new Uint8Array([0, ...ephemeral.publicKey, ...nonce, ...wrapped])) },
      daemon_wrapped_data_key: null, signature: '',
      ...overrides,
    }
    const signingPayload = [
      'falcondeck-session-bootstrap-v1', 'data_key_v1', 'ed25519_v1',
      material.pairing_id, material.session_id, material.daemon_public_key,
      material.daemon_identity_public_key, material.client_public_key,
      material.client_identity_public_key, material.client_wrapped_data_key.wrapped_key, '',
    ].join('\n')
    material.signature = bytesToBase64(nacl.sign.detached(
      new TextEncoder().encode(signingPayload), deriveIdentityKeyPair(daemon).secretKey,
    ))
    return { id: `bootstrap-${seq}`, seq, created_at: new Date().toISOString(),
      body: { t: 'session-bootstrap', material } }
  }
  return { dataKey, phone, persisted, bootstrap }
}
