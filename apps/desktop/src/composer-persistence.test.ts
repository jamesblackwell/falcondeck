import { beforeEach, describe, expect, it } from 'vitest'

import {
  composerProviderFor,
  composerSelectionFor,
  draftKeyFor,
  MAX_COMPOSER_DRAFTS,
  parseComposerDrafts,
  parsePersistedComposerState,
  preferredPermissionMode,
  resolvePersistedMode,
  resolvePermissionMode,
  upsertComposerDraft,
  withComposerProvider,
  withComposerSelection,
  type ComposerDrafts,
  type PersistedComposerState,
} from '@falcondeck/client-core'

import {
  readPersistedComposerState,
  readStoredDrafts,
  writePersistedComposerState,
  writeStoredDrafts,
} from './composer-persistence'

describe('draftKeyFor', () => {
  it('gives each conversation its own key, including the per-workspace new-thread composer', () => {
    expect(draftKeyFor('ws-1', 'thread-1')).not.toBe(draftKeyFor('ws-1', 'thread-2'))
    expect(draftKeyFor('ws-1', null)).not.toBe(draftKeyFor('ws-1', 'thread-1'))
    expect(draftKeyFor('ws-1', null)).not.toBe(draftKeyFor('ws-2', null))
    expect(draftKeyFor(null, null)).toBe(draftKeyFor(null, null))
  })
})

describe('upsertComposerDraft', () => {
  it('stores and replaces text per conversation', () => {
    let drafts: ComposerDrafts = {}
    drafts = upsertComposerDraft(drafts, 'a', 'hello', 1)
    drafts = upsertComposerDraft(drafts, 'b', 'other', 2)
    drafts = upsertComposerDraft(drafts, 'a', 'hello again', 3)
    expect(drafts.a).toEqual({ text: 'hello again', updatedAt: 3 })
    expect(drafts.b).toEqual({ text: 'other', updatedAt: 2 })
  })

  it('returns the same object when nothing changes, so callers can skip persisting', () => {
    const drafts = upsertComposerDraft({}, 'a', 'hello', 1)
    expect(upsertComposerDraft(drafts, 'a', 'hello', 2)).toBe(drafts)
    expect(upsertComposerDraft(drafts, 'missing', '', 2)).toBe(drafts)
  })

  it('removes the entry when the text is cleared', () => {
    const drafts = upsertComposerDraft({}, 'a', 'hello', 1)
    expect(upsertComposerDraft(drafts, 'a', '', 2)).toEqual({})
  })

  it('drops the least recently updated drafts beyond the cap', () => {
    let drafts: ComposerDrafts = {}
    for (let i = 0; i <= MAX_COMPOSER_DRAFTS; i += 1) {
      drafts = upsertComposerDraft(drafts, `key-${i}`, `text ${i}`, i)
    }
    expect(Object.keys(drafts)).toHaveLength(MAX_COMPOSER_DRAFTS)
    expect(drafts['key-0']).toBeUndefined()
    expect(drafts[`key-${MAX_COMPOSER_DRAFTS}`]).toBeDefined()
  })
})

describe('parseComposerDrafts', () => {
  it('round-trips serialized drafts and drops malformed entries', () => {
    const raw = JSON.stringify({
      good: { text: 'keep me', updatedAt: 10 },
      emptyText: { text: '', updatedAt: 10 },
      badTimestamp: { text: 'x', updatedAt: 'later' },
      notAnObject: 'nope',
    })
    expect(parseComposerDrafts(raw)).toEqual({ good: { text: 'keep me', updatedAt: 10 } })
  })

  it('tolerates garbage input', () => {
    expect(parseComposerDrafts(null)).toEqual({})
    expect(parseComposerDrafts('not json')).toEqual({})
    expect(parseComposerDrafts('[1,2]')).toEqual({})
  })
})

describe('persisted composer state', () => {
  it('round-trips provider and mode selections', () => {
    let state: PersistedComposerState = {}
    state = withComposerProvider(state, '/repo', 'claude')
    state = withComposerSelection(state, '/repo', 'claude', {
      modelId: 'claude-fable-5',
      effort: 'max',
    })
    state = withComposerSelection(state, '/repo', 'claude', {
      permissionMode: 'bypassPermissions',
    })

    const reparsed = parsePersistedComposerState(JSON.stringify(state))
    expect(composerProviderFor(reparsed, '/repo')).toBe('claude')
    expect(composerSelectionFor(reparsed, '/repo', 'claude')).toEqual({
      modelId: 'claude-fable-5',
      effort: 'max',
      permissionMode: 'bypassPermissions',
      sandboxMode: null,
      serviceTier: null,
    })
  })

  it('patches one field without clobbering the rest', () => {
    let state = withComposerSelection({}, '/repo', 'claude', {
      modelId: 'claude-fable-5',
      effort: 'max',
      permissionMode: 'bypassPermissions',
      sandboxMode: null,
    })
    state = withComposerSelection(state, '/repo', 'claude', { effort: 'medium' })
    expect(composerSelectionFor(state, '/repo', 'claude')).toEqual({
      modelId: 'claude-fable-5',
      effort: 'medium',
      permissionMode: 'bypassPermissions',
      sandboxMode: null,
      serviceTier: null,
    })
  })

  it('keeps per-provider selections independent and leaves the sticky provider alone', () => {
    let state = withComposerProvider({}, '/repo', 'claude')
    state = withComposerSelection(state, '/repo', 'codex', { sandboxMode: 'workspace-write' })
    expect(composerProviderFor(state, '/repo')).toBe('claude')
    expect(composerSelectionFor(state, '/repo', 'claude')).toBeNull()
    expect(composerSelectionFor(state, '/repo', 'codex')?.sandboxMode).toBe('workspace-write')
  })

  it('returns the same object when re-remembering the same provider', () => {
    const state = withComposerProvider({}, '/repo', 'claude')
    expect(withComposerProvider(state, '/repo', 'claude')).toBe(state)
  })

  it('migrates the legacy model/effort store', () => {
    const legacy = JSON.stringify({
      '/repo': { claude: { modelId: 'claude-fable-5', effort: 'max' } },
    })
    const state = parsePersistedComposerState(null, legacy)
    expect(composerProviderFor(state, '/repo')).toBeNull()
    expect(composerSelectionFor(state, '/repo', 'claude')).toEqual({
      modelId: 'claude-fable-5',
      effort: 'max',
      permissionMode: null,
      sandboxMode: null,
      serviceTier: null,
    })
  })

  it('prefers the current store over the legacy one and tolerates garbage', () => {
    const current = JSON.stringify({
      '/repo': { provider: 'codex', selections: {} },
    })
    const legacy = JSON.stringify({
      '/repo': { claude: { modelId: 'old', effort: 'low' } },
    })
    expect(composerProviderFor(parsePersistedComposerState(current, legacy), '/repo')).toBe('codex')
    expect(parsePersistedComposerState('not json', 'also not json')).toEqual({})
  })
})

describe('resolvePersistedMode', () => {
  it('keeps a remembered mode only while the provider still advertises it', () => {
    const modes = ['default', 'acceptEdits', 'bypassPermissions']
    expect(resolvePersistedMode('bypassPermissions', modes)).toBe('bypassPermissions')
    expect(resolvePersistedMode('dontAsk', modes)).toBeNull()
    expect(resolvePersistedMode(null, modes)).toBeNull()
    expect(resolvePersistedMode(undefined, [])).toBeNull()
    expect(resolvePersistedMode('default', modes)).toBeNull()
  })

  it('defaults new permission selections to bypass when the harness offers it', () => {
    const modes = ['default', 'acceptEdits', 'bypassPermissions']
    expect(preferredPermissionMode(modes)).toBe('bypassPermissions')
    expect(resolvePermissionMode(null, modes)).toBe('bypassPermissions')
    expect(resolvePermissionMode('default', modes)).toBeNull()
    expect(resolvePermissionMode('bypassPermissions', [])).toBe('bypassPermissions')
    expect(resolvePermissionMode('stale-mode', modes)).toBe('bypassPermissions')
  })

  it('uses common permissive ACP ids without hard-coding a provider', () => {
    expect(preferredPermissionMode(['default', 'yolo'])).toBe('yolo')
    expect(preferredPermissionMode(['default', 'plan'])).toBeNull()
  })
})

describe('storage wrappers', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('round-trips drafts through localStorage', () => {
    const drafts = upsertComposerDraft({}, 'ws-1:new', 'unsent text', 5)
    writeStoredDrafts(drafts)
    expect(readStoredDrafts()).toEqual(drafts)
  })

  it('reads the legacy selections key and removes it on the next write', () => {
    window.localStorage.setItem(
      'falcondeck.desktop.composer-selections.v1',
      JSON.stringify({ '/repo': { claude: { modelId: 'claude-fable-5', effort: 'max' } } }),
    )
    const state = readPersistedComposerState()
    expect(composerSelectionFor(state, '/repo', 'claude')?.modelId).toBe('claude-fable-5')

    writePersistedComposerState(state)
    expect(window.localStorage.getItem('falcondeck.desktop.composer-selections.v1')).toBeNull()
    expect(readPersistedComposerState()).toEqual(state)
  })
})
