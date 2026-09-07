import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  bytesToBase64, encryptJson, RelayDecryptionError, secretKeyToBase64,
  type RelayClientMessage,
} from '@falcondeck/client-core'
import { getJson } from '@/storage/mmkv'
import { loadClientSecretKey, loadClientToken, loadDataKey } from '@/storage/secure'
import { restoreTestRelaySession } from '@/test/relay-session'
import { useRelayStore } from './relay-store'

const originalSend = useRelayStore.getState()._sendMessage
const originalDecrypt = useRelayStore.getState()._decryptJson

async function startRpc(timeoutMs?: number) {
  type RpcCall = Extract<RelayClientMessage, { type: 'rpc-call' }>
  let sent!: (message: RpcCall) => void
  const outgoing = new Promise<RpcCall>(resolve => { sent = resolve })
  const send = vi.fn((message: RelayClientMessage) => {
    if (message.type === 'rpc-call') sent(message)
  })
  useRelayStore.setState({ _sendMessage: send })
  const result = useRelayStore.getState()._callRpc('sync.index', {}, { timeoutMs })
  return { call: await outgoing, result, send }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
beforeEach(() => { useRelayStore.getState()._setSocket(null) })
afterEach(() => {
  useRelayStore.getState()._failPendingRpcs('test complete')
  useRelayStore.setState({ _sendMessage: originalSend, _decryptJson: originalDecrypt })
  useRelayStore.getState()._setSocket(null)
  useRelayStore.getState()._setSessionCrypto(null)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each([true, false])('recovers a persisted wrong key through a signed bootstrap (RPC ok=%s)', async (ok) => {
  const { dataKey: correctKey, phone, persisted, bootstrap } = await restoreTestRelaySession()
  const sent: RelayClientMessage[] = []
  useRelayStore.setState({ _sendMessage: message => { sent.push(message) } })

  const request = useRelayStore.getState()._callRpc('sync.index', {})
  const rejected = expect(request).rejects.toThrow('Refreshing the secure connection')
  await vi.waitFor(() => expect(sent[0]?.type).toBe('rpc-call'))
  const first = sent[0]
  if (first.type !== 'rpc-call') throw new Error('missing RPC')
  await useRelayStore.getState()._handleRpcResult({
    type: 'rpc-result', request_id: first.request_id, ok,
    result: ok ? await encryptJson(correctKey, { token: 'fresh' }) : null,
    error: ok ? null : await encryptJson(correctKey, { message: 'invalid remote rpc payload' }),
  })
  await rejected
  expect(useRelayStore.getState()._getSessionCrypto()).toBeNull()
  expect(sent.filter(message => message.type === 'ephemeral')).toHaveLength(1)
  expect(useRelayStore.getState().sessionId).toBe('session')
  expect(await loadClientSecretKey()).toBe(secretKeyToBase64(phone))
  expect(await loadClientToken()).toBe('test-token')
  expect(getJson('relay.session')).toEqual(persisted)
  expect(await loadDataKey()).toBe(bytesToBase64(new Uint8Array(32).fill(13)))
  await useRelayStore.getState()._processBootstrap(bootstrap())
  expect(useRelayStore.getState()._getSessionCrypto()?.dataKey).toEqual(correctKey)
  expect(await loadDataKey()).toBe(bytesToBase64(correctKey))
  const retry = useRelayStore.getState()._callRpc('sync.index', {})
  await vi.waitFor(() => expect(sent.filter(message => message.type === 'rpc-call')).toHaveLength(2))
  const last = sent.at(-1)!
  if (last.type !== 'rpc-call') throw new Error('missing retry')
  await useRelayStore.getState()._handleRpcResult({
    type: 'rpc-result', request_id: last.request_id, ok: true, error: null,
    result: await encryptJson(correctKey, { token: 'fresh' }),
  })
  await expect(retry).resolves.toEqual({ token: 'fresh' })
  // A subsequent cold restore must use the repaired Keychain value.
  useRelayStore.getState()._setSessionCrypto(null)
  await useRelayStore.getState().restoreSession()
  expect(useRelayStore.getState()._getSessionCrypto()?.dataKey).toEqual(correctKey)
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

it('coalesces concurrent authentication failures into one bootstrap and rejects every pending RPC', async () => {
  const { dataKey } = await restoreTestRelaySession()
  const first = await startRpc()
  const second = await startRpc()
  const rejected = Promise.all([
    expect(first.result).rejects.toThrow('Refreshing the secure connection'),
    expect(second.result).rejects.toThrow('Refreshing the secure connection'),
  ])
  const encrypted = await encryptJson(dataKey, {})
  await Promise.all([first, second].map(({ call }) => useRelayStore.getState()._handleRpcResult({
    type: 'rpc-result', request_id: call.request_id, ok: true, result: encrypted, error: null,
  })))
  await rejected
  expect(second.send.mock.calls.filter(([message]) => message.type === 'ephemeral')).toHaveLength(1)
  expect(await useRelayStore.getState()._handleRpcResult({
    type: 'rpc-result', request_id: first.call.request_id, ok: true, result: encrypted, error: null,
  })).toBe(false)
})

it.each(['application error', 'malformed envelope'] as const)('retains a good key after an RPC %s', async kind => {
  const { dataKey } = await restoreTestRelaySession(new Uint8Array(32).fill(42))
  const crypto = useRelayStore.getState()._getSessionCrypto()
  const { call, result, send } = await startRpc()
  const rejected = expect(result).rejects.toThrow(kind === 'application error' ? 'workspace not found' : 'Encrypted payload is malformed')
  const envelope = await encryptJson(dataKey, { message: 'workspace not found' })
  await useRelayStore.getState()._handleRpcResult({
    type: 'rpc-result', request_id: call.request_id, ok: false, result: null,
    error: kind === 'application error' ? envelope : { ...envelope, ciphertext: '' },
  })
  await rejected
  expect(useRelayStore.getState()._getSessionCrypto()).toBe(crypto)
  expect(send.mock.calls.filter(([message]) => message.type === 'ephemeral')).toHaveLength(0)
})

it.each(['success', 'authentication failure'] as const)('discards a late decrypt %s after key rotation', async outcome => {
  const { dataKey } = await restoreTestRelaySession()
  const { call, result, send } = await startRpc()
  const rejected = expect(result).rejects.toThrow()
  const pending = deferred<unknown>()
  useRelayStore.setState({ _decryptJson: <T>() => pending.promise as Promise<T> })
  const handling = useRelayStore.getState()._handleRpcResult({
    type: 'rpc-result', request_id: call.request_id, ok: true,
    result: await encryptJson(dataKey, { token: 'old' }), error: null,
  })
  const current = { dataKey: new Uint8Array(dataKey), material: null }
  useRelayStore.getState()._setSessionCrypto(current)
  if (outcome === 'success') pending.resolve({ token: 'obsolete' })
  else pending.reject(new RelayDecryptionError(new Error('old native operation failed')))
  await handling
  await rejected
  expect(useRelayStore.getState()._getSessionCrypto()).toBe(current)
  expect(current.dataKey).toEqual(dataKey)
  expect(send.mock.calls.filter(([message]) => message.type === 'ephemeral')).toHaveLength(0)
})

it('rejects a response from a replaced socket without decrypting it or discarding its still-valid key', async () => {
  const { dataKey } = await restoreTestRelaySession(new Uint8Array(32).fill(42))
  const { call, result } = await startRpc()
  const rejected = expect(result).rejects.toThrow('Remote connection changed')
  const decrypt = vi.fn(originalDecrypt)
  useRelayStore.setState({ _decryptJson: <T>(envelope: Parameters<typeof originalDecrypt>[0]) => decrypt(envelope) as Promise<T> })
  const crypto = useRelayStore.getState()._getSessionCrypto()
  useRelayStore.getState()._setSocket({} as WebSocket)
  await useRelayStore.getState()._handleRpcResult({
    type: 'rpc-result', request_id: call.request_id, ok: true,
    result: await encryptJson(dataKey, {}), error: null,
  })
  await rejected
  expect(decrypt).not.toHaveBeenCalled()
  expect(useRelayStore.getState()._getSessionCrypto()).toBe(crypto)
})

it('keeps the RPC deadline active during native decryption and ignores the eventual result', async () => {
  await restoreTestRelaySession(new Uint8Array(32).fill(42))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { call, result } = await startRpc(1000)
  const rejected = expect(result).rejects.toThrow('Timed out waiting for sync.index')
  const pending = deferred<unknown>()
  useRelayStore.setState({ _decryptJson: <T>() => pending.promise as Promise<T> })
  const handling = useRelayStore.getState()._handleRpcResult({
    type: 'rpc-result', request_id: call.request_id, ok: true, result: call.params, error: null,
  })
  await vi.advanceTimersByTimeAsync(1000)
  await rejected
  pending.resolve({ token: 'too late' })
  await handling
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['tampered signature', 'another session', 'another daemon'] as const)('rejects a bootstrap for %s without losing the working key', async kind => {
  const { bootstrap, dataKey } = await restoreTestRelaySession(new Uint8Array(32).fill(42))
  const crypto = useRelayStore.getState()._getSessionCrypto()
  const update = bootstrap(11, kind === 'another session'
    ? { session_id: 'other-session' }
    : kind === 'another daemon' ? { daemon_public_key: bytesToBase64(new Uint8Array(32).fill(99)) } : {})
  if (kind === 'tampered signature' && update.body.t === 'session-bootstrap') {
    update.body.material.signature = bytesToBase64(new Uint8Array(64))
  }
  await useRelayStore.getState()._processBootstrap(update)
  expect(useRelayStore.getState().error).toBeTruthy()
  expect(useRelayStore.getState()._getSessionCrypto()).toBe(crypto)
  expect(crypto?.dataKey).toEqual(dataKey)
  expect(await loadDataKey()).toBe(bytesToBase64(dataKey))
})
