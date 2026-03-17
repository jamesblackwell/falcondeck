import { describe, it, expect, beforeEach } from 'vitest'
import { __reset } from 'expo-secure-store'

import {
  persistClientSecretKey,
  loadClientSecretKey,
  persistDataKey,
  loadDataKey,
  persistClientToken,
  loadClientToken,
  clearSecureSession,
} from './secure'

describe('secure storage', () => {
  beforeEach(() => {
    __reset()
  })

  it('persists and loads client secret key', async () => {
    await persistClientSecretKey('secret-key-base64')
    expect(await loadClientSecretKey()).toBe('secret-key-base64')
  })

  it('persists and loads data key', async () => {
    await persistDataKey('data-key-base64')
    expect(await loadDataKey()).toBe('data-key-base64')
  })

  it('persists and loads client token', async () => {
    await persistClientToken('token-abc')
    expect(await loadClientToken()).toBe('token-abc')
  })

  it('returns null for missing keys', async () => {
    expect(await loadClientSecretKey()).toBeNull()
    expect(await loadDataKey()).toBeNull()
    expect(await loadClientToken()).toBeNull()
  })

  it('clearSecureSession removes all keys', async () => {
    await persistClientSecretKey('key1')
    await persistDataKey('key2')
    await persistClientToken('key3')

    await clearSecureSession()

    expect(await loadClientSecretKey()).toBeNull()
    expect(await loadDataKey()).toBeNull()
    expect(await loadClientToken()).toBeNull()
  })
})
