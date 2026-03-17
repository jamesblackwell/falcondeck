import { describe, it, expect, beforeEach } from 'vitest'
import { __resetAllStores } from 'react-native-mmkv'

import { storage, getJson, setJson, removeKey, mmkvStorage } from './mmkv'

describe('mmkv storage helpers', () => {
  beforeEach(() => {
    __resetAllStores()
  })

  it('getJson returns null for missing keys', () => {
    expect(getJson('nonexistent')).toBeNull()
  })

  it('setJson/getJson round-trips objects', () => {
    setJson('user', { name: 'James', age: 30 })
    expect(getJson<{ name: string; age: number }>('user')).toEqual({
      name: 'James',
      age: 30,
    })
  })

  it('setJson/getJson round-trips arrays', () => {
    setJson('items', [1, 2, 3])
    expect(getJson<number[]>('items')).toEqual([1, 2, 3])
  })

  it('removeKey deletes a key', () => {
    setJson('temp', { value: 1 })
    expect(getJson('temp')).toBeTruthy()

    removeKey('temp')
    expect(getJson('temp')).toBeNull()
  })

  it('getJson returns null for corrupted JSON', () => {
    storage.set('bad', '{invalid json}}}')
    expect(getJson('bad')).toBeNull()
  })

  it('mmkvStorage adapter works with zustand persist', () => {
    mmkvStorage.setItem('zustand-key', '{"count":42}')
    expect(mmkvStorage.getItem('zustand-key')).toBe('{"count":42}')

    mmkvStorage.removeItem('zustand-key')
    expect(mmkvStorage.getItem('zustand-key')).toBeNull()
  })
})
