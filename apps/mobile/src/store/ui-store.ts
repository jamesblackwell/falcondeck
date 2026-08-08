import { create } from 'zustand'

import {
  draftKeyFor,
  parseComposerDrafts,
  parsePersistedComposerState,
  upsertComposerDraft,
  withComposerProvider,
  withComposerSelection,
  type AgentProvider,
  type ComposerDrafts,
  type ImageInput,
  type PersistedComposerSelection,
  type PersistedComposerState,
} from '@falcondeck/client-core'

import { storage } from '@/storage/mmkv'

// Device-local composer memory, matching the desktop/remote-web stores: unsent
// input keyed per conversation, picker choices remembered per workspace.
const DRAFTS_STORAGE_KEY = 'falcondeck.mobile.composer-drafts.v1'
const COMPOSER_STATE_STORAGE_KEY = 'falcondeck.mobile.composer-selections.v1'

function writeStoredDrafts(drafts: ComposerDrafts) {
  try {
    storage.set(DRAFTS_STORAGE_KEY, JSON.stringify(drafts))
  } catch {
    // Ignore storage failures and keep the in-memory drafts authoritative.
  }
}

function writePersistedComposerState(state: PersistedComposerState) {
  try {
    storage.set(COMPOSER_STATE_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Ignore storage failures and keep the in-memory selection authoritative.
  }
}

interface UIState {
  /**
   * Identity of the conversation the composer is editing: the selected
   * thread, or the per-workspace "new thread" slot. Kept in sync with the
   * session store's selection so `draft`/`attachments` always belong to the
   * conversation on screen instead of bleeding across navigation.
   */
  conversationKey: string
  drafts: ComposerDrafts
  attachmentsByConversation: Record<string, ImageInput[]>
  /** The current conversation's unsent text — a mirror of `drafts[conversationKey]`. */
  draft: string
  /** The current conversation's attachments — a mirror of the keyed map. */
  attachments: ImageInput[]
  selectedProvider: AgentProvider | null
  selectedModel: string | null
  selectedEffort: string | null
  /** Tier id while fast mode is on; null is the provider's standard tier. */
  selectedServiceTier: string | null
  /** null means "no override" — the daemon keeps whatever the thread already has. */
  selectedPermissionMode: string | null
  selectedSandboxMode: string | null
  /** Last-used picker choices per workspace path, persisted device-locally. */
  persistedComposerSelections: PersistedComposerState
  isSubmitting: boolean
}

interface UIActions {
  setConversation: (workspaceId: string | null, threadId: string | null) => void
  setDraft: (draft: string) => void
  setAttachments: (attachments: ImageInput[]) => void
  addAttachments: (attachments: ImageInput[]) => void
  removeAttachment: (attachmentId: string) => void
  setSelectedProvider: (provider: AgentProvider | null) => void
  setSelectedModel: (modelId: string | null) => void
  setSelectedEffort: (effort: string | null) => void
  setSelectedServiceTier: (tier: string | null) => void
  setSelectedPermissionMode: (mode: string | null) => void
  setSelectedSandboxMode: (mode: string | null) => void
  rememberComposerSelection: (
    workspacePath: string,
    provider: AgentProvider,
    patch: Partial<PersistedComposerSelection>,
  ) => void
  rememberWorkspaceProvider: (workspacePath: string, provider: AgentProvider) => void
  setIsSubmitting: (submitting: boolean) => void
  clearAttachments: () => void
  clearDraft: () => void
}

type UIStore = UIState & UIActions

const initialDrafts = parseComposerDrafts(storage.getString(DRAFTS_STORAGE_KEY) ?? null)
const initialConversationKey = draftKeyFor(null, null)

export const useUIStore = create<UIStore>((set, get) => ({
  conversationKey: initialConversationKey,
  drafts: initialDrafts,
  attachmentsByConversation: {},
  draft: initialDrafts[initialConversationKey]?.text ?? '',
  attachments: [],
  selectedProvider: null,
  selectedModel: null,
  selectedEffort: 'medium',
  selectedServiceTier: null,
  selectedPermissionMode: null,
  selectedSandboxMode: null,
  persistedComposerSelections: parsePersistedComposerState(
    storage.getString(COMPOSER_STATE_STORAGE_KEY) ?? null,
  ),
  isSubmitting: false,

  setConversation: (workspaceId, threadId) => {
    const conversationKey = draftKeyFor(workspaceId, threadId)
    if (conversationKey === get().conversationKey) return
    set((state) => ({
      conversationKey,
      draft: state.drafts[conversationKey]?.text ?? '',
      attachments: state.attachmentsByConversation[conversationKey] ?? [],
    }))
  },
  setDraft: (draft) =>
    set((state) => {
      const drafts = upsertComposerDraft(state.drafts, state.conversationKey, draft)
      if (drafts !== state.drafts) writeStoredDrafts(drafts)
      return { drafts, draft }
    }),
  setAttachments: (attachments) =>
    set((state) => {
      const attachmentsByConversation = { ...state.attachmentsByConversation }
      if (attachments.length === 0) {
        delete attachmentsByConversation[state.conversationKey]
      } else {
        attachmentsByConversation[state.conversationKey] = attachments
      }
      return { attachmentsByConversation, attachments }
    }),
  addAttachments: (attachments) => get().setAttachments([...get().attachments, ...attachments]),
  removeAttachment: (attachmentId) =>
    get().setAttachments(get().attachments.filter((attachment) => attachment.id !== attachmentId)),
  setSelectedProvider: (provider) => set({ selectedProvider: provider }),
  setSelectedModel: (modelId) => set({ selectedModel: modelId }),
  setSelectedEffort: (effort) => set({ selectedEffort: effort }),
  setSelectedServiceTier: (tier) => set({ selectedServiceTier: tier }),
  setSelectedPermissionMode: (mode) => set({ selectedPermissionMode: mode }),
  setSelectedSandboxMode: (mode) => set({ selectedSandboxMode: mode }),
  rememberComposerSelection: (workspacePath, provider, patch) =>
    set((state) => {
      const persistedComposerSelections = withComposerSelection(
        state.persistedComposerSelections,
        workspacePath,
        provider,
        patch,
      )
      writePersistedComposerState(persistedComposerSelections)
      return { persistedComposerSelections }
    }),
  rememberWorkspaceProvider: (workspacePath, provider) =>
    set((state) => {
      const persistedComposerSelections = withComposerProvider(
        state.persistedComposerSelections,
        workspacePath,
        provider,
      )
      if (persistedComposerSelections === state.persistedComposerSelections) return state
      writePersistedComposerState(persistedComposerSelections)
      return { persistedComposerSelections }
    }),
  setIsSubmitting: (submitting) => set({ isSubmitting: submitting }),
  clearAttachments: () => get().setAttachments([]),
  clearDraft: () => get().setDraft(''),
}))
