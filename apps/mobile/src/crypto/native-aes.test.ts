import { afterEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { AESEncryptionKey } from 'expo-crypto'
import { decryptJson, destroySessionCrypto, encryptJson, RelayDecryptionError, setAesGcmBackend } from '@falcondeck/client-core'
import { installNativeAes } from './native-aes'

// Model Expo's native byte/tag contract with independent WebCrypto AES.
vi.mock('expo-crypto', () => ({
  AESEncryptionKey: {
    import: vi.fn(async (bytes: Uint8Array) =>
      webcrypto.subtle.importKey('raw', new Uint8Array(bytes), 'AES-GCM', false, ['encrypt', 'decrypt'])),
  },
  AESSealedData: {
    fromParts: (nonce: Uint8Array, ciphertext: Uint8Array, tagLength: number) => {
      expect(tagLength).toBe(16)
      return { nonce, ciphertext }
    },
  },
  aesEncryptAsync: async (plaintext: Uint8Array, key: CryptoKey, options: { nonce: { bytes: Uint8Array } }) => {
    const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(options.nonce.bytes) }, key, new Uint8Array(plaintext))
    return { ciphertext: async (options: { includeTag: boolean }) => {
      expect(options.includeTag).toBe(true)
      return new Uint8Array(ciphertext)
    } }
  },
  aesDecryptAsync: async (sealed: { nonce: Uint8Array; ciphertext: Uint8Array }, key: CryptoKey) =>
    new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(sealed.nonce) }, key, new Uint8Array(sealed.ciphertext))),
}))

afterEach(() => { setAesGcmBackend(null); vi.clearAllMocks() })

describe('native relay AES', () => {
  it('reads existing wire envelopes and produces envelopes the default backend can read', async () => {
    const key = new Uint8Array(32).fill(4)
    const payload = { text: 'Hello 🔐'.repeat(1000) }
    const existing = await encryptJson(key, payload)
    installNativeAes()
    expect(await decryptJson(key, existing)).toEqual(payload)
    const native = await encryptJson(key, payload)
    expect(AESEncryptionKey.import).toHaveBeenCalledTimes(1)
    setAesGcmBackend(null)
    expect(await decryptJson(key, native)).toEqual(payload)
  })

  it('rejects unauthenticated ciphertext instead of falling back', async () => {
    const key = new Uint8Array(32).fill(5)
    const existing = await encryptJson(key, { text: 'secret' })
    installNativeAes()
    await expect(decryptJson(new Uint8Array(32).fill(6), existing)).rejects.toBeInstanceOf(RelayDecryptionError)
  })

  it('shares one native key import across a concurrent encrypt/decrypt burst', async () => {
    installNativeAes()
    const key = new Uint8Array(32).fill(8)
    const values = Array.from({ length: 20 }, (_, index) => ({ index, text: 'parallel 🔐' }))
    const encrypted = await Promise.all(values.map(value => encryptJson(key, value)))
    const decrypted = await Promise.all(encrypted.map(value => decryptJson(key, value)))
    expect(decrypted).toEqual(values)
    expect(AESEncryptionKey.import).toHaveBeenCalledTimes(1)
  })

  it('retries a transient native import failure instead of caching a rejected promise forever', async () => {
    installNativeAes()
    const key = new Uint8Array(32).fill(9)
    vi.mocked(AESEncryptionKey.import).mockRejectedValueOnce(new Error('native import unavailable'))
    await expect(encryptJson(key, {})).rejects.toThrow('native import unavailable')
    const encrypted = await encryptJson(key, { recovered: true })
    await expect(decryptJson(key, encrypted)).resolves.toEqual({ recovered: true })
    expect(AESEncryptionKey.import).toHaveBeenCalledTimes(2)
  })

  it('copies key bytes before an asynchronous native import can race with session teardown', async () => {
    installNativeAes()
    const key = new Uint8Array(32).fill(10)
    const expectedKey = new Uint8Array(key)
    const importKey = vi.mocked(AESEncryptionKey.import)
    const implementation = importKey.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    importKey.mockImplementationOnce(async (...args) => { await gate; return implementation(...args) })
    const encrypted = encryptJson(key, { inFlight: true })
    destroySessionCrypto({ dataKey: key, material: null })
    release()
    const envelope = await encrypted
    setAesGcmBackend(null)
    await expect(decryptJson(expectedKey, envelope)).resolves.toEqual({ inFlight: true })
    expect(key).toEqual(new Uint8Array(32))
  })

  it('releases cached native key handles on session teardown', async () => {
    installNativeAes()
    const key = new Uint8Array(32).fill(7)
    await encryptJson(key, {})
    destroySessionCrypto({ dataKey: key } as never)
    expect(key.every((byte) => byte === 0)).toBe(true)
    await encryptJson(key, {})
    expect(AESEncryptionKey.import).toHaveBeenCalledTimes(2)
  })
})
