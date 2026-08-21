import { describe, it, expect, beforeEach } from 'vitest'
import { __resetAllStores } from 'react-native-mmkv'

import { readStoredThreadSort, writeStoredThreadSort } from './thread-sort'

describe('thread sort storage', () => {
  beforeEach(() => {
    __resetAllStores()
  })

  it('defaults to last updated', () => {
    expect(readStoredThreadSort()).toBe('last_updated')
  })

  it('round-trips a valid sort mode', () => {
    writeStoredThreadSort('priority')
    expect(readStoredThreadSort()).toBe('priority')
    writeStoredThreadSort('alphabetical')
    expect(readStoredThreadSort()).toBe('alphabetical')
  })
})
