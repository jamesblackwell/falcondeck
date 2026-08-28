import { create } from 'zustand';

import {
  draftKeyFor,
  mergeFailedComposerAttachments,
  mergeFailedComposerDraft,
  parseComposerDrafts,
  parsePersistedComposerState,
  upsertComposerDraft,
  withComposerProvider,
  withComposerSelection,
  type AgentProvider,
  type ComposerDrafts,
  type ConversationItem,
  type ImageInput,
  type PersistedComposerSelection,
  type PersistedComposerState,
} from '@falcondeck/client-core';

import { storage } from '@/storage/mmkv';

// Device-local composer memory, matching the desktop/remote-web stores: unsent
// input keyed per conversation, picker choices remembered per workspace.
const DRAFTS_STORAGE_KEY = 'falcondeck.mobile.composer-drafts.v1';
const COMPOSER_STATE_STORAGE_KEY = 'falcondeck.mobile.composer-selections.v1';
// Text of sends that have left the composer but whose turn has not settled.
// The composer is emptied the instant the user hits send — the transcript
// already shows the message, so holding the text there reads as a duplicate —
// and this is what stands in for it if the process dies mid-request.
const IN_FLIGHT_STORAGE_KEY = 'falcondeck.mobile.composer-in-flight.v1';

function writeStoredDrafts(drafts: ComposerDrafts) {
  try {
    storage.set(DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // Ignore storage failures and keep the in-memory drafts authoritative.
  }
}

/**
 * Draft persistence runs behind a burst-aware writer: keystrokes fire far
 * faster than MMKV needs to, so a burst commits its first change immediately
 * (a crash right after typing starts cannot lose the whole message) and
 * coalesces everything after it into one trailing write ~300ms after the
 * last change. A process killed mid-burst loses only the unflushed tail —
 * MMKV keeps the last committed value.
 */
const DRAFT_PERSIST_DEBOUNCE_MS = 300;
let draftPersistTimer: ReturnType<typeof setTimeout> | null = null;
// Newest drafts of the in-flight burst, awaiting its trailing write.
let pendingStoredDrafts: ComposerDrafts | null = null;

/** Commits any draft burst still waiting on its trailing write right away. */
export function flushStoredDrafts() {
  if (draftPersistTimer !== null) {
    clearTimeout(draftPersistTimer);
    draftPersistTimer = null;
  }
  const pending = pendingStoredDrafts;
  pendingStoredDrafts = null;
  if (pending !== null) writeStoredDrafts(pending);
}

function scheduleStoredDraftsWrite(drafts: ComposerDrafts) {
  // Each call supersedes the queued value — only the newest matters.
  pendingStoredDrafts = drafts;
  if (draftPersistTimer === null) {
    // Leading edge of a burst: write immediately instead of waiting out the
    // trailing delay, then arm the trailing write for everything that follows.
    writeStoredDrafts(drafts);
    pendingStoredDrafts = null;
  }
  if (draftPersistTimer !== null) clearTimeout(draftPersistTimer);
  draftPersistTimer = setTimeout(flushStoredDrafts, DRAFT_PERSIST_DEBOUNCE_MS);
}

/** Synchronous counterpart: cancels any queued burst write, then commits. */
function writeStoredDraftsNow(drafts: ComposerDrafts) {
  if (draftPersistTimer !== null) {
    clearTimeout(draftPersistTimer);
    draftPersistTimer = null;
    pendingStoredDrafts = null;
  }
  writeStoredDrafts(drafts);
}

function writeStoredInFlight(inFlight: ComposerDrafts) {
  try {
    storage.set(IN_FLIGHT_STORAGE_KEY, JSON.stringify(inFlight))
  } catch {
    // Ignore storage failures and keep the in-memory record authoritative.
  }
}

function writePersistedComposerState(state: PersistedComposerState) {
  try {
    storage.set(COMPOSER_STATE_STORAGE_KEY, JSON.stringify(state));
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
  conversationKey: string;
  drafts: ComposerDrafts;
  attachmentsByConversation: Record<string, ImageInput[]>;
  /** The current conversation's unsent text — a mirror of `drafts[conversationKey]`. */
  draft: string;
  /** The current conversation's attachments — a mirror of the keyed map. */
  attachments: ImageInput[];
  selectedProvider: AgentProvider | null;
  selectedModel: string | null;
  selectedEffort: string | null;
  /** Tier id while fast mode is on; null is the provider's standard tier. */
  selectedServiceTier: string | null;
  /** null means "no override" — the daemon keeps whatever the thread already has. */
  selectedPermissionMode: string | null;
  selectedSandboxMode: string | null;
  /** Last-used picker choices per workspace path, persisted device-locally. */
  persistedComposerSelections: PersistedComposerState;
  /** In-flight sends keyed by their owning conversation. */
  pendingSubmissions: Record<string, true>;
  /** Text of each in-flight send, held until its turn is accepted or fails. */
  inFlightSubmissions: ComposerDrafts;
  /** First user message while a new thread is still being created. */
  pendingNewThreadItem: {
    conversationKey: string;
    item: ConversationItem;
  } | null;
  isSubmitting: boolean;
}

interface UIActions {
  setConversation: (workspaceId: string | null, threadId: string | null) => void;
  setDraft: (draft: string) => void;
  setAttachments: (attachments: ImageInput[]) => void;
  setComposerForConversation: (
    conversationKey: string,
    draft: string,
    attachments: ImageInput[],
  ) => void;
  addAttachments: (attachments: ImageInput[]) => void;
  removeAttachment: (attachmentId: string) => void;
  restoreFailedSubmission: (
    conversationKey: string,
    failedDraft: string,
    failedAttachments: ImageInput[],
  ) => void;
  setSelectedProvider: (provider: AgentProvider | null) => void;
  setSelectedModel: (modelId: string | null) => void;
  setSelectedEffort: (effort: string | null) => void;
  setSelectedServiceTier: (tier: string | null) => void;
  setSelectedPermissionMode: (mode: string | null) => void;
  setSelectedSandboxMode: (mode: string | null) => void;
  rememberComposerSelection: (
    workspacePath: string,
    provider: AgentProvider,
    patch: Partial<PersistedComposerSelection>,
  ) => void;
  rememberWorkspaceProvider: (workspacePath: string, provider: AgentProvider) => void;
  /** Empties the composer into the in-flight record as a send starts. */
  beginSubmission: (conversationKey: string, submittedDraft: string) => void;
  /** Follows a send onto the thread the daemon just created for it. */
  moveSubmission: (fromConversationKey: string, toConversationKey: string) => void;
  /** Drops the in-flight copy once its turn is accepted, queued, or restored. */
  endSubmission: (conversationKey: string) => void;
  setIsSubmitting: (submitting: boolean, conversationKey?: string) => void;
  setPendingNewThreadItem: (pending: UIState['pendingNewThreadItem']) => void;
  clearPendingNewThreadItem: (itemId: string) => void;
  clearAttachments: () => void;
  clearDraft: () => void;
}

type UIStore = UIState & UIActions;

// Anything still recorded as in flight belongs to a send this process never
// saw settle — iOS killed the app mid-request — so it goes back to the
// composer it was taken from before anything reads the drafts.
const storedInFlight = parseComposerDrafts(storage.getString(IN_FLIGHT_STORAGE_KEY) ?? null);
const initialDrafts = Object.entries(storedInFlight).reduce(
  (drafts, [conversationKey, { text }]) =>
    upsertComposerDraft(
      drafts,
      conversationKey,
      mergeFailedComposerDraft(text, drafts[conversationKey]?.text ?? ''),
    ),
  parseComposerDrafts(storage.getString(DRAFTS_STORAGE_KEY) ?? null),
);
if (Object.keys(storedInFlight).length > 0) {
  writeStoredDraftsNow(initialDrafts);
  writeStoredInFlight({});
}
const initialConversationKey = draftKeyFor(null, null);

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
  pendingSubmissions: {},
  inFlightSubmissions: {},
  pendingNewThreadItem: null,
  isSubmitting: false,

  setConversation: (workspaceId, threadId) => {
    const conversationKey = draftKeyFor(workspaceId, threadId);
    if (conversationKey === get().conversationKey) return;
    set((state) => ({
      conversationKey,
      draft: state.drafts[conversationKey]?.text ?? '',
      attachments: state.attachmentsByConversation[conversationKey] ?? [],
      isSubmitting: Boolean(state.pendingSubmissions[conversationKey]),
    }));
  },
  setDraft: (draft) =>
    set((state) => {
      const drafts = upsertComposerDraft(state.drafts, state.conversationKey, draft);
      // Per-keystroke MMKV writes dominate composer input cost; the burst
      // writer commits immediately once, then coalesces into a trailing write.
      if (drafts !== state.drafts) scheduleStoredDraftsWrite(drafts);
      return { drafts, draft };
    }),
  setAttachments: (attachments) =>
    set((state) => {
      const attachmentsByConversation = { ...state.attachmentsByConversation };
      if (attachments.length === 0) {
        delete attachmentsByConversation[state.conversationKey];
      } else {
        attachmentsByConversation[state.conversationKey] = attachments;
      }
      return { attachmentsByConversation, attachments };
    }),
  setComposerForConversation: (conversationKey, draft, attachments) =>
    set((state) => {
      const drafts = upsertComposerDraft(state.drafts, conversationKey, draft);
      const attachmentsByConversation = { ...state.attachmentsByConversation };
      if (attachments.length === 0) {
        delete attachmentsByConversation[conversationKey];
      } else {
        attachmentsByConversation[conversationKey] = attachments;
      }
      // Not keystroke-driven: commit synchronously so a queued burst write
      // cannot later clobber this newer snapshot with a stale value.
      if (drafts !== state.drafts) writeStoredDraftsNow(drafts);
      return {
        drafts,
        attachmentsByConversation,
        ...(state.conversationKey === conversationKey ? { draft, attachments } : {}),
      };
    }),
  addAttachments: (attachments) => get().setAttachments([...get().attachments, ...attachments]),
  removeAttachment: (attachmentId) =>
    get().setAttachments(get().attachments.filter((attachment) => attachment.id !== attachmentId)),
  restoreFailedSubmission: (conversationKey, failedDraft, failedAttachments) =>
    set((state) => {
      const draft = mergeFailedComposerDraft(
        failedDraft,
        state.drafts[conversationKey]?.text ?? '',
      );
      const attachments = mergeFailedComposerAttachments(
        failedAttachments,
        state.attachmentsByConversation[conversationKey] ?? [],
      );
      const drafts = upsertComposerDraft(state.drafts, conversationKey, draft);
      const attachmentsByConversation = {
        ...state.attachmentsByConversation,
        [conversationKey]: attachments,
      };
      if (attachments.length === 0) delete attachmentsByConversation[conversationKey];
      // Failure recovery must land synchronously, superseding any queued
      // burst write from earlier keystrokes.
      if (drafts !== state.drafts) writeStoredDraftsNow(drafts);
      return {
        drafts,
        attachmentsByConversation,
        ...(state.conversationKey === conversationKey ? { draft, attachments } : {}),
      };
    }),
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
      );
      writePersistedComposerState(persistedComposerSelections);
      return { persistedComposerSelections };
    }),
  rememberWorkspaceProvider: (workspacePath, provider) =>
    set((state) => {
      const persistedComposerSelections = withComposerProvider(
        state.persistedComposerSelections,
        workspacePath,
        provider,
      );
      if (persistedComposerSelections === state.persistedComposerSelections) return state;
      writePersistedComposerState(persistedComposerSelections);
      return { persistedComposerSelections };
    }),
  beginSubmission: (conversationKey, submittedDraft) => {
    // Settle any in-flight draft burst first so the persisted drafts key and
    // the in-flight record are written in logical order for crash recovery.
    flushStoredDrafts();
    set((state) => {
      const inFlightSubmissions = upsertComposerDraft(
        state.inFlightSubmissions,
        conversationKey,
        submittedDraft,
      );
      if (inFlightSubmissions !== state.inFlightSubmissions) {
        writeStoredInFlight(inFlightSubmissions);
      }
      return { inFlightSubmissions };
    });
    get().setComposerForConversation(conversationKey, '', []);
  },
  moveSubmission: (fromConversationKey, toConversationKey) =>
    set((state) => {
      const moved = state.inFlightSubmissions[fromConversationKey];
      if (!moved) return state;
      const inFlightSubmissions = upsertComposerDraft(
        upsertComposerDraft(state.inFlightSubmissions, fromConversationKey, ''),
        toConversationKey,
        moved.text,
      );
      writeStoredInFlight(inFlightSubmissions);
      return { inFlightSubmissions };
    }),
  endSubmission: (conversationKey) =>
    set((state) => {
      const inFlightSubmissions = upsertComposerDraft(
        state.inFlightSubmissions,
        conversationKey,
        '',
      );
      if (inFlightSubmissions === state.inFlightSubmissions) return state;
      writeStoredInFlight(inFlightSubmissions);
      return { inFlightSubmissions };
    }),
  setIsSubmitting: (submitting, requestedConversationKey) =>
    set((state) => {
      const conversationKey = requestedConversationKey ?? state.conversationKey;
      const pendingSubmissions = { ...state.pendingSubmissions };
      if (submitting) {
        pendingSubmissions[conversationKey] = true;
      } else {
        delete pendingSubmissions[conversationKey];
      }
      return {
        pendingSubmissions,
        isSubmitting: Boolean(pendingSubmissions[state.conversationKey]),
      };
    }),
  setPendingNewThreadItem: (pendingNewThreadItem) => set({ pendingNewThreadItem }),
  clearPendingNewThreadItem: (itemId) =>
    set((state) =>
      state.pendingNewThreadItem?.item.id === itemId ? { pendingNewThreadItem: null } : state,
    ),
  clearAttachments: () => get().setAttachments([]),
  clearDraft: () => get().setDraft(''),
}));
