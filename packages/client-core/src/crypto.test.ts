import { afterEach, describe, expect, it, vi } from 'vitest'

import { decryptJson, encryptJson } from './crypto'

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
})
