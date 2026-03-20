import { describe, it, expect } from 'vitest'

import {
  generateBoxKeyPair,
  publicKeyToBase64,
  secretKeyToBase64,
  restoreBoxKeyPair,
  bytesToBase64,
  base64ToBytes,
  encryptJson,
  decryptJson,
  bootstrapSessionCrypto,
} from './index'

describe('crypto re-exports from client-core', () => {
  it('generateBoxKeyPair produces valid keypair', () => {
    const kp = generateBoxKeyPair()
    expect(kp.publicKey).toBeInstanceOf(Uint8Array)
    expect(kp.secretKey).toBeInstanceOf(Uint8Array)
    expect(kp.publicKey.length).toBe(32)
    expect(kp.secretKey.length).toBe(32)
  })

  it('publicKeyToBase64 / secretKeyToBase64 produce base64 strings', () => {
    const kp = generateBoxKeyPair()
    const pub = publicKeyToBase64(kp)
    const sec = secretKeyToBase64(kp)
    expect(typeof pub).toBe('string')
    expect(typeof sec).toBe('string')
    expect(pub.length).toBeGreaterThan(0)
    expect(sec.length).toBeGreaterThan(0)
    expect(pub).not.toBe(sec)
  })

  it('restoreBoxKeyPair round-trips a keypair through base64', () => {
    const original = generateBoxKeyPair()
    const secretBase64 = secretKeyToBase64(original)
    const restored = restoreBoxKeyPair(secretBase64)

    expect(publicKeyToBase64(restored)).toBe(publicKeyToBase64(original))
  })

  it('bytesToBase64 / base64ToBytes round-trips bytes', () => {
    const original = new Uint8Array([1, 2, 3, 255, 0, 128])
    const b64 = bytesToBase64(original)
    const restored = base64ToBytes(b64)
    expect(Array.from(restored)).toEqual(Array.from(original))
  })

  it('encryptJson / decryptJson round-trips JSON data', async () => {
    const dataKey = crypto.getRandomValues(new Uint8Array(32))
    const payload = { message: 'hello', count: 42, nested: { ok: true } }

    const envelope = await encryptJson(dataKey, payload)
    expect(envelope).toBeDefined()
    expect(typeof envelope.ciphertext).toBe('string')

    const decrypted = await decryptJson<typeof payload>(dataKey, envelope)
    expect(decrypted).toEqual(payload)
  })

  it('decryptJson fails with wrong key', async () => {
    const key1 = crypto.getRandomValues(new Uint8Array(32))
    const key2 = crypto.getRandomValues(new Uint8Array(32))

    const envelope = await encryptJson(key1, { secret: true })
    await expect(decryptJson(key2, envelope)).rejects.toThrow()
  })

  it('each encryption produces different ciphertext (unique nonces)', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    const data = { same: 'data' }

    const e1 = await encryptJson(key, data)
    const e2 = await encryptJson(key, data)
    expect(e1.ciphertext).not.toBe(e2.ciphertext)
  })

  it('falls back to pure-js AES-GCM when crypto.subtle is unavailable', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    const payload = { mobile: true, works: 'without subtle' }
    const originalCrypto = globalThis.crypto

    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
        randomUUID: originalCrypto.randomUUID?.bind(originalCrypto),
        subtle: undefined,
      },
    })

    try {
      const envelope = await encryptJson(key, payload)
      await expect(decryptJson<typeof payload>(key, envelope)).resolves.toEqual(payload)
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
      })
    }
  })
})
