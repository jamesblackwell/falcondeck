import { describe, it, expect } from 'vitest'
import {
  useRelayStore,
  useSessionStore,
  useGroups,
  useSelectedWorkspace,
  useSelectedThread,
  useConversationItems,
  useApprovals,
  useUIStore,
} from './index'

describe('store barrel exports', () => {
  it('exports useRelayStore', () => {
    expect(useRelayStore).toBeDefined()
    expect(typeof useRelayStore.getState).toBe('function')
  })

  it('exports useSessionStore', () => {
    expect(useSessionStore).toBeDefined()
    expect(typeof useSessionStore.getState).toBe('function')
  })

  it('exports useUIStore', () => {
    expect(useUIStore).toBeDefined()
    expect(typeof useUIStore.getState).toBe('function')
  })

  it('exports derived selector hooks', () => {
    expect(typeof useGroups).toBe('function')
    expect(typeof useSelectedWorkspace).toBe('function')
    expect(typeof useSelectedThread).toBe('function')
    expect(typeof useConversationItems).toBe('function')
    expect(typeof useApprovals).toBe('function')
  })
})
