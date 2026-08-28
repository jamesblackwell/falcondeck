import { describe, it, expect, beforeEach } from 'vitest'
import { __resetAllStores } from 'react-native-mmkv'

import { readStoredChatsCollapsed, writeStoredChatsCollapsed } from './chats-collapsed'

describe('chats collapsed storage', () => {
  beforeEach(() => {
    __resetAllStores()
  })

  it('defaults to expanded', () => {
    expect(readStoredChatsCollapsed()).toBe(false)
  })

  it('round-trips the collapsed flag', () => {
    writeStoredChatsCollapsed(true)
    expect(readStoredChatsCollapsed()).toBe(true)
    writeStoredChatsCollapsed(false)
    expect(readStoredChatsCollapsed()).toBe(false)
  })
})
