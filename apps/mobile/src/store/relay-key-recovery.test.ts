import { afterEach, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import {
  buildPairingPublicKeyBundle, bytesToBase64, deriveIdentityKeyPair,
  encryptJson, generateBoxKeyPair, REMOTE_SESSION_STORAGE_VERSION,
  secretKeyToBase64, type SessionKeyMaterial, type RelayClientMessage,
} from '@falcondeck/client-core'
import { setJson } from '@/storage/mmkv'
import { persistClientSecretKey, persistClientToken, persistDataKey } from '@/storage/secure'
import { useRelayStore } from './relay-store'

const originalSend = useRelayStore.getState()._sendMessage
afterEach(() => {
  useRelayStore.getState()._failPendingRpcs('test complete')
  useRelayStore.setState({ _sendMessage: originalSend })
  useRelayStore.getState()._setSessionCrypto(null)
})

it('recovers a persisted wrong key through a signed bootstrap and successfully decrypts the retried sync', async () => {
  const phone = generateBoxKeyPair()
  const daemon = generateBoxKeyPair()
  const phoneBundle = buildPairingPublicKeyBundle(phone)
  const daemonBundle = buildPairingPublicKeyBundle(daemon)
  const correctKey = new Uint8Array(32).fill(42)
  await persistClientSecretKey(secretKeyToBase64(phone))
  await persistClientToken('test-token')
  await persistDataKey(bytesToBase64(new Uint8Array(32).fill(13)))
  setJson('relay.session', {
    version: REMOTE_SESSION_STORAGE_VERSION, relayUrl: 'https://relay.test',
    pairingCode: '', pairingId: 'pairing', sessionId: 'session', deviceId: 'phone',
    daemonPublicKey: daemonBundle.public_key,
    daemonIdentityPublicKey: daemonBundle.identity_public_key, lastReceivedSeq: 10,
  })
  await useRelayStore.getState().restoreSession()
  const sent: RelayClientMessage[] = []
  useRelayStore.setState({ _sendMessage: message => { sent.push(message) } })

  const request = useRelayStore.getState()._callRpc('sync.index', {})
  const rejected = expect(request).rejects.toThrow('Refreshing the secure connection')
  await vi.waitFor(() => expect(sent[0]?.type).toBe('rpc-call'))
  const first = sent[0]
  if (first.type !== 'rpc-call') throw new Error('missing RPC')
  await useRelayStore.getState()._handleRpcResult({
    type: 'rpc-result', request_id: first.request_id, ok: false, result: null,
    error: await encryptJson(correctKey, { message: 'invalid remote rpc payload' }),
  })
  await rejected
  expect(useRelayStore.getState()._getSessionCrypto()).toBeNull()
  expect(sent.filter(message => message.type === 'ephemeral')).toHaveLength(1)
  expect(useRelayStore.getState().sessionId).toBe('session')

  const ephemeral = nacl.box.keyPair()
  const nonce = new Uint8Array(24).fill(7)
  const wrapped = nacl.box(correctKey, nonce, phone.publicKey, ephemeral.secretKey)
  const material: SessionKeyMaterial = {
    encryption_variant: 'data_key_v1', identity_variant: 'ed25519_v1',
    pairing_id: 'pairing', session_id: 'session',
    daemon_public_key: daemonBundle.public_key,
    daemon_identity_public_key: daemonBundle.identity_public_key,
    client_public_key: phoneBundle.public_key,
    client_identity_public_key: phoneBundle.identity_public_key,
    client_wrapped_data_key: { encryption_variant: 'data_key_v1', wrapped_key:
      bytesToBase64(new Uint8Array([0, ...ephemeral.publicKey, ...nonce, ...wrapped])) },
    daemon_wrapped_data_key: null, signature: '',
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
  await useRelayStore.getState()._processBootstrap({
    id: 'bootstrap', seq: 11, created_at: new Date().toISOString(),
    body: { t: 'session-bootstrap', material },
  })
  expect(useRelayStore.getState()._getSessionCrypto()?.dataKey).toEqual(correctKey)
  const retry = useRelayStore.getState()._callRpc('sync.index', {})
  await vi.waitFor(() => expect(sent.filter(message => message.type === 'rpc-call')).toHaveLength(2))
  const last = sent.at(-1)!
  if (last.type !== 'rpc-call') throw new Error('missing retry')
  await useRelayStore.getState()._handleRpcResult({
    type: 'rpc-result', request_id: last.request_id, ok: true, error: null,
    result: await encryptJson(correctKey, { token: 'fresh' }),
  })
  await expect(retry).resolves.toEqual({ token: 'fresh' })
})

it('does not let a stale recovery erase a newer session key', () => {
  const old = { dataKey: new Uint8Array(32).fill(1), material: null }
  const current = { dataKey: new Uint8Array(32).fill(2), material: null }
  useRelayStore.getState()._setSessionCrypto(old)
  useRelayStore.getState()._setSessionCrypto(current)
  useRelayStore.getState()._recoverSessionCrypto(old)
  expect(useRelayStore.getState()._getSessionCrypto()).toBe(current)
})

it('keeps a confirmed key and its pending RPC alive when the same bootstrap key is repeated', async () => {
  const crypto = { dataKey: new Uint8Array(32).fill(42), material: null }
  useRelayStore.getState()._setSessionCrypto(crypto)
  const sent: RelayClientMessage[] = []
  useRelayStore.setState({ _sendMessage: message => { sent.push(message) } })
  const request = useRelayStore.getState()._callRpc('sync.index', {})
  await vi.waitFor(() => expect(sent[0]?.type).toBe('rpc-call'))
  useRelayStore.getState()._setSessionCrypto({ dataKey: new Uint8Array(crypto.dataKey), material: null })
  expect(useRelayStore.getState()._getSessionCrypto()).toBe(crypto)
  expect(crypto.dataKey).toEqual(new Uint8Array(32).fill(42))
  const call = sent[0]
  if (call.type !== 'rpc-call') throw new Error('missing RPC')
  await useRelayStore.getState()._handleRpcResult({
    type: 'rpc-result', request_id: call.request_id, ok: true, error: null,
    result: await encryptJson(crypto.dataKey, { token: 'confirmed' }),
  })
  await expect(request).resolves.toEqual({ token: 'confirmed' })
})

it('rejects an RPC immediately on disconnect even while native decryption is pending', async () => {
  useRelayStore.getState()._setSessionCrypto({ dataKey: new Uint8Array(32).fill(42), material: null })
  const sent: RelayClientMessage[] = []
  const originalDecrypt = useRelayStore.getState()._decryptJson
  let finishDecrypt!: (value: unknown) => void
  useRelayStore.setState({
    _sendMessage: message => { sent.push(message) },
    _decryptJson: <T>() => new Promise<T>(resolve => { finishDecrypt = value => resolve(value as T) }),
  })
  try {
    const request = useRelayStore.getState()._callRpc('sync.index', {})
    const rejected = expect(request).rejects.toThrow('Desktop disconnected')
    await vi.waitFor(() => expect(sent[0]?.type).toBe('rpc-call'))
    const call = sent[0]
    if (call.type !== 'rpc-call') throw new Error('missing RPC')
    const processing = useRelayStore.getState()._handleRpcResult({
      type: 'rpc-result', request_id: call.request_id, ok: true, error: null,
      result: await encryptJson(new Uint8Array(32).fill(42), {}),
    })
    useRelayStore.getState()._failPendingRpcs('Desktop disconnected')
    await rejected
    finishDecrypt({ token: 'obsolete' })
    await processing
  } finally {
    useRelayStore.setState({ _decryptJson: originalDecrypt })
  }
})
