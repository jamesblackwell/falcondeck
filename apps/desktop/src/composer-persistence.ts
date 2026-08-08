import {
  parseComposerDrafts,
  parsePersistedComposerState,
  type ComposerDrafts,
  type PersistedComposerState,
} from '@falcondeck/client-core'

// Device-local, like the appearance settings: drafts and composer picker
// choices describe this machine's half-typed input, not workspace state, so
// they stay out of the daemon's falcondeck.json.
const DRAFTS_STORAGE_KEY = 'falcondeck.desktop.composer-drafts.v1'
const COMPOSER_STATE_STORAGE_KEY = 'falcondeck.desktop.composer-selections.v2'
const LEGACY_COMPOSER_SELECTIONS_KEY = 'falcondeck.desktop.composer-selections.v1'

export function readStoredDrafts(): ComposerDrafts {
  if (typeof window === 'undefined') return {}
  try {
    return parseComposerDrafts(window.localStorage.getItem(DRAFTS_STORAGE_KEY))
  } catch {
    return {}
  }
}

export function writeStoredDrafts(drafts: ComposerDrafts) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(drafts))
  } catch {
    // Ignore storage failures and keep the in-memory drafts authoritative.
  }
}

export function readPersistedComposerState(): PersistedComposerState {
  if (typeof window === 'undefined') return {}
  try {
    return parsePersistedComposerState(
      window.localStorage.getItem(COMPOSER_STATE_STORAGE_KEY),
      window.localStorage.getItem(LEGACY_COMPOSER_SELECTIONS_KEY),
    )
  } catch {
    return {}
  }
}

export function writePersistedComposerState(state: PersistedComposerState) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(COMPOSER_STATE_STORAGE_KEY, JSON.stringify(state))
    window.localStorage.removeItem(LEGACY_COMPOSER_SELECTIONS_KEY)
  } catch {
    // Ignore storage failures and keep the in-memory selection authoritative.
  }
}
