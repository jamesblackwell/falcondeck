import type { AgentProvider } from './types'

/**
 * Device-local composer memory: unsent draft text kept per conversation, and
 * the picker choices (provider, model, effort, permission/sandbox mode) the
 * user last made per workspace. Pure parse/update helpers only — each app owns
 * its storage keys and does the actual localStorage/MMKV access, so the same
 * logic serves desktop and remote-web without either depending on the other's
 * key names.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Per-conversation drafts

export type ComposerDraft = {
  text: string
  updatedAt: number
}

export type ComposerDrafts = Record<string, ComposerDraft>

/** Conversations a device keeps unsent text for; least recently updated are dropped. */
export const MAX_COMPOSER_DRAFTS = 100

/**
 * Identity of one composer conversation: an existing thread, or the single
 * "new thread" composer each workspace has. Drafts and attachments are keyed
 * by this so navigating never carries unsent input across conversations.
 */
export function draftKeyFor(workspaceId: string | null, threadId: string | null): string {
  return `${workspaceId ?? 'none'}:${threadId ?? 'new'}`
}

export function parseComposerDrafts(raw: string | null): ComposerDrafts {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return {}
    const drafts: ComposerDrafts = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue
      const { text, updatedAt } = value
      if (typeof text !== 'string' || text.length === 0) continue
      if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) continue
      drafts[key] = { text, updatedAt }
    }
    return drafts
  } catch {
    return {}
  }
}

/**
 * Sets, replaces, or (for empty text) removes one conversation's draft.
 * Returns the input object unchanged when nothing would change, so callers can
 * skip persisting.
 */
export function upsertComposerDraft(
  drafts: ComposerDrafts,
  key: string,
  text: string,
  now: number = Date.now(),
): ComposerDrafts {
  const existing = drafts[key]
  if (text.length === 0) {
    if (!existing) return drafts
    const next = { ...drafts }
    delete next[key]
    return next
  }
  if (existing && existing.text === text) return drafts
  const next = { ...drafts, [key]: { text, updatedAt: now } }
  const keys = Object.keys(next)
  if (keys.length <= MAX_COMPOSER_DRAFTS) return next
  keys.sort((a, b) => next[a].updatedAt - next[b].updatedAt)
  for (const stale of keys.slice(0, keys.length - MAX_COMPOSER_DRAFTS)) {
    delete next[stale]
  }
  return next
}

// ---------------------------------------------------------------------------
// Sticky picker selections

export type PersistedComposerSelection = {
  modelId: string | null
  effort: string | null
  permissionMode: string | null
  sandboxMode: string | null
}

export type WorkspaceComposerState = {
  /** Provider the user last explicitly chose for new threads in this workspace. */
  provider: AgentProvider | null
  selections: Partial<Record<AgentProvider, PersistedComposerSelection>>
}

/** Keyed by workspace path, matching the pre-existing selections store. */
export type PersistedComposerState = Record<string, WorkspaceComposerState>

const EMPTY_COMPOSER_SELECTION: PersistedComposerSelection = {
  modelId: null,
  effort: null,
  permissionMode: null,
  sandboxMode: null,
}

function normalizeSelection(value: Record<string, unknown>): PersistedComposerSelection {
  return {
    modelId: typeof value.modelId === 'string' ? value.modelId : null,
    effort: typeof value.effort === 'string' ? value.effort : null,
    permissionMode: typeof value.permissionMode === 'string' ? value.permissionMode : null,
    sandboxMode: typeof value.sandboxMode === 'string' ? value.sandboxMode : null,
  }
}

function normalizeComposerState(raw: string | null): PersistedComposerState {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return {}
    const state: PersistedComposerState = {}
    for (const [workspacePath, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue
      const provider =
        typeof value.provider === 'string' && value.provider.length > 0 ? value.provider : null
      const selections: Partial<Record<AgentProvider, PersistedComposerSelection>> = {}
      if (isRecord(value.selections)) {
        for (const [selectionProvider, selection] of Object.entries(value.selections)) {
          if (selectionProvider.length === 0 || !isRecord(selection)) continue
          selections[selectionProvider] = normalizeSelection(selection)
        }
      }
      if (provider === null && Object.keys(selections).length === 0) continue
      state[workspacePath] = { provider, selections }
    }
    return state
  } catch {
    return {}
  }
}

/** The pre-provider store shape: workspace path → provider → {modelId, effort}. */
function migrateLegacyComposerSelections(raw: string | null): PersistedComposerState {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return {}
    const state: PersistedComposerState = {}
    for (const [workspacePath, selections] of Object.entries(parsed)) {
      if (!isRecord(selections)) continue
      const migrated: Partial<Record<AgentProvider, PersistedComposerSelection>> = {}
      for (const [provider, selection] of Object.entries(selections)) {
        if (provider.length === 0 || !isRecord(selection)) continue
        migrated[provider] = normalizeSelection(selection)
      }
      if (Object.keys(migrated).length > 0) {
        state[workspacePath] = { provider: null, selections: migrated }
      }
    }
    return state
  } catch {
    return {}
  }
}

export function parsePersistedComposerState(
  raw: string | null,
  legacyRaw: string | null = null,
): PersistedComposerState {
  const current = normalizeComposerState(raw)
  if (Object.keys(current).length > 0) return current
  return migrateLegacyComposerSelections(legacyRaw)
}

export function composerSelectionFor(
  state: PersistedComposerState,
  workspacePath: string | null | undefined,
  provider: AgentProvider,
): PersistedComposerSelection | null {
  if (!workspacePath) return null
  return state[workspacePath]?.selections[provider] ?? null
}

export function composerProviderFor(
  state: PersistedComposerState,
  workspacePath: string | null | undefined,
): AgentProvider | null {
  if (!workspacePath) return null
  return state[workspacePath]?.provider ?? null
}

/**
 * Merges a partial picker change into the remembered selection for one
 * provider, leaving the other remembered fields (and the workspace's sticky
 * provider) alone.
 */
export function withComposerSelection(
  state: PersistedComposerState,
  workspacePath: string,
  provider: AgentProvider,
  patch: Partial<PersistedComposerSelection>,
): PersistedComposerState {
  const workspaceState = state[workspacePath] ?? { provider: null, selections: {} }
  const existing = workspaceState.selections[provider] ?? EMPTY_COMPOSER_SELECTION
  const merged: PersistedComposerSelection = {
    modelId: patch.modelId !== undefined ? patch.modelId : existing.modelId,
    effort: patch.effort !== undefined ? patch.effort : existing.effort,
    permissionMode:
      patch.permissionMode !== undefined ? patch.permissionMode : existing.permissionMode,
    sandboxMode: patch.sandboxMode !== undefined ? patch.sandboxMode : existing.sandboxMode,
  }
  return {
    ...state,
    [workspacePath]: {
      ...workspaceState,
      selections: { ...workspaceState.selections, [provider]: merged },
    },
  }
}

export function withComposerProvider(
  state: PersistedComposerState,
  workspacePath: string,
  provider: AgentProvider,
): PersistedComposerState {
  const workspaceState = state[workspacePath] ?? { provider: null, selections: {} }
  if (workspaceState.provider === provider) return state
  return { ...state, [workspacePath]: { ...workspaceState, provider } }
}

/**
 * A remembered mode only applies while the provider still advertises it; an
 * unknown or absent mode falls back to the provider default (null).
 */
export function resolvePersistedMode(
  mode: string | null | undefined,
  availableModes: string[],
): string | null {
  return mode && availableModes.includes(mode) ? mode : null
}
