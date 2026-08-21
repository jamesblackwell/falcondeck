import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildPairingPublicKeyBundle,
  bytesToBase64,
  decodeSecurePairingCode,
  decryptJson,
  decryptJsonBatch,
  encryptJson,
  generateBoxKeyPair,
  normalizePairingCodeInput,
  restoreBoxKeyPair,
  signPairingAuthorityClientBundle,
  signPairingAuthorityDaemonBundle,
  verifyPairingAuthorityDaemonBundle,
} from './crypto'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AES session key reuse', () => {
  it('imports one WebCrypto key for concurrent encrypt/decrypt bursts', async () => {
    const key = new Uint8Array(32).fill(23)
    const importKey = vi.spyOn(globalThis.crypto.subtle, 'importKey')

    const [first, second] = await Promise.all([
      encryptJson(key, { delta: 'one' }),
      encryptJson(key, { delta: 'two' }),
    ])
    expect(await decryptJson<{ delta: string }>(key, first)).toEqual({ delta: 'one' })
    expect(await decryptJson<{ delta: string }>(key, second)).toEqual({ delta: 'two' })
    expect(importKey).toHaveBeenCalledTimes(1)
  })

  it('imports a new key when a session key rotates', async () => {
    const firstKey = new Uint8Array(32).fill(31)
    const secondKey = new Uint8Array(32).fill(32)
    const importKey = vi.spyOn(globalThis.crypto.subtle, 'importKey')

    await encryptJson(firstKey, { value: 1 })
    await encryptJson(firstKey, { value: 2 })
    await encryptJson(secondKey, { value: 3 })

    expect(importKey).toHaveBeenCalledTimes(2)
  })

  it('decrypts batches in order while isolating malformed envelopes', async () => {
    const key = new Uint8Array(32).fill(41)
    const [first, third] = await Promise.all([
      encryptJson(key, { value: 1 }),
      encryptJson(key, { value: 3 }),
    ])
    const results = await decryptJsonBatch<{ value: number }>(key, [
      first,
      { ...first, ciphertext: 'malformed' },
      third,
    ])

    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { value: 1 } })
    expect(results[1]).toMatchObject({ status: 'rejected' })
    expect(results[2]).toMatchObject({ status: 'fulfilled', value: { value: 3 } })
  })
})

describe('secure pairing authority', () => {
  it('normalizes only the case-insensitive lookup prefix', () => {
    expect(normalizePairingCodeInput('pair-code.AbCd_-90')).toBe('PAIR-CODE.AbCd_-90')
  })

  it('authenticates the daemon bundle independently of the relay', () => {
    const authoritySecret = bytesToBase64(new Uint8Array(32).fill(73))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const daemonBundle = buildPairingPublicKeyBundle(generateBoxKeyPair())
    const authority = signPairingAuthorityDaemonBundle(authoritySecret, daemonBundle)

    expect(decodeSecurePairingCode(`PAIRCODE1234.${authoritySecret}`)).toMatchObject({
      pairingCode: 'PAIRCODE1234',
      authoritySecret,
      authorityPublicKey: authority.publicKey,
    })
    expect(() =>
      verifyPairingAuthorityDaemonBundle(
        authoritySecret,
        authority.publicKey,
        daemonBundle,
        authority.signature,
      ),
    ).not.toThrow()

    const substitutedBundle = buildPairingPublicKeyBundle(generateBoxKeyPair())
    expect(() =>
      verifyPairingAuthorityDaemonBundle(
        authoritySecret,
        authority.publicKey,
        substitutedBundle,
        authority.signature,
      ),
    ).toThrow(/not authenticated/)
  })

  it('rejects legacy short codes that carry no trust anchor', () => {
    expect(() => decodeSecurePairingCode('PAIRCODE1234')).toThrow(/incomplete/)
  })

  it('matches the Rust cross-language signature vector', () => {
    const authoritySecret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const daemonBundle = buildPairingPublicKeyBundle(
      restoreBoxKeyPair('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='),
    )
    const clientBundle = buildPairingPublicKeyBundle(
      restoreBoxKeyPair('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='),
    )
    const daemonAuthority = signPairingAuthorityDaemonBundle(authoritySecret, daemonBundle)

    expect(daemonAuthority).toEqual({
      publicKey: 'O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik=',
      signature:
        'wCrI7qKJO0uifk2BqDXX8ZfxfDNk0yf/E4ozPZe02COc9CvyO+LT1M/n8PzWxwr1r4e+O4JllSXRAv6KcHB/Ag==',
    })
    expect(
      signPairingAuthorityClientBundle(
        authoritySecret,
        'PAIRCODE',
        'Q0hBTExFTkdF',
        clientBundle,
      ),
    ).toBe(
      'DVq/C16oRCP/BgAGVEJm1wvVWk4GGcQvkFfDfsQOYDVowyvvopxP3v+dh3KwFYzX/lbNUs73c55mZIhq4YI6CA==',
    )
  })
})
