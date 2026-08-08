import { beforeEach, describe, expect, it } from 'vitest'

import {
  composerSelectionFor,
  parsePersistedComposerState,
  withComposerSelection,
} from '@falcondeck/client-core'

import { readPersistedComposerState, writePersistedComposerState } from './composer-persistence'

describe('remote composer permission persistence', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('remembers a permission choice for the next conversation in the same workspace', () => {
    const state = withComposerSelection({}, '/repo', 'grok', {
      permissionMode: 'bypassPermissions',
    })

    writePersistedComposerState(state)

    expect(composerSelectionFor(readPersistedComposerState(), '/repo', 'grok')).toEqual({
      modelId: null,
      effort: null,
      permissionMode: 'bypassPermissions',
      sandboxMode: null,
      serviceTier: null,
    })
  })

  it('keeps an explicit default distinct from an unconfigured selection', () => {
    const state = withComposerSelection({}, '/repo', 'claude', { permissionMode: 'default' })
    const restored = parsePersistedComposerState(JSON.stringify(state))

    expect(composerSelectionFor(restored, '/repo', 'claude')?.permissionMode).toBe('default')
  })
})
