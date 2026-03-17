/**
 * Additional crypto tests — covers ensureWebCrypto branch.
 */
import { describe, it, expect } from 'vitest'
import { ensureWebCrypto } from './index'

describe('ensureWebCrypto', () => {
  it('resolves when crypto.subtle is available (Node 20+ / Hermes)', async () => {
    // In Node test environment, crypto.subtle IS available
    await expect(ensureWebCrypto()).resolves.toBeUndefined()
  })
})
