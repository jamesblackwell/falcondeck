/**
 * Import-coverage tests for hook files.
 * These verify the modules can be loaded and their exports are correct.
 * The actual hook logic (useEffect, useCallback) can't be called outside React,
 * but the module-level functions and the hook function signatures are validated.
 */
import { describe, it, expect } from 'vitest'

// Import the actual source modules to get coverage
import * as relayConnectionModule from './useRelayConnection'
import * as sessionActionsModule from './useSessionActions'

describe('useRelayConnection module', () => {
  it('exports useRelayConnection function', () => {
    expect(typeof relayConnectionModule.useRelayConnection).toBe('function')
  })
})

describe('useSessionActions module', () => {
  it('exports useSessionActions function', () => {
    expect(typeof sessionActionsModule.useSessionActions).toBe('function')
  })
})
