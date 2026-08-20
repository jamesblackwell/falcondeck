/**
 * Session store — daemon snapshot, threads, conversation items.
 *
 * Consumes decrypted daemon events from the relay connection and
 * maintains the same state shape as the desktop/remote-web apps,
 * plus a mobile-only cache of recent thread history windows.
 */
import { useMemo } from 'react';

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import {
  MOBILE_SESSION_CACHE_VERSION,
  applyConversationEventsToItems,
  applySnapshotEvent,
  buildProjectGroups,
  mergeThreadDetailPage,
  normalizeDaemonSnapshot,
  normalizeConversationItem,
  reconcileSnapshotSelection,
  removeConversationItem,
  threadForSelection,
  upsertConversationItem,
  type CachedThreadHistory,
  type ConversationItem,
  type DaemonSnapshot,
  type EventEnvelope,
  type MobileSessionCache,
  type ThinkingDisplay,
  type ThreadDetail,
  type ThreadHandle,
  type ThreadSummary,
} from '@falcondeck/client-core';

import { clearMobileSessionCache, persistMobileSessionCache } from '@/storage/mobile-session-cache';

import { useUIStore } from './ui-store';

const MAX_CACHED_THREADS = 5;
const MAX_CACHED_ITEMS = 150;

type ThreadDetailMergeMode = 'refresh' | 'prepend';

export interface ThreadHistoryState {
  hasOlder: boolean;
  oldestItemId: string | null;
  newestItemId: string | null;
  isPartial: boolean;
}

interface SessionState {
  snapshot: DaemonSnapshot | null;
  selectedWorkspaceId: string | null;
  selectedThreadId: string | null;
  threadItems: Record<string, ConversationItem[]>;
  threadHistory: Record<string, ThreadHistoryState>;
  threadDetail: ThreadDetail | null;
  /** Per-thread tail-load failures, so a flaky network shows an explicit
   * error instead of a false "No messages yet" empty state. */
  threadDetailErrors: Record<string, string>;
}

interface SessionActions {
  applyDaemonEvent: (event: EventEnvelope) => void;
  applyDaemonEvents: (events: EventEnvelope[]) => void;
  setPreferences: (preferences: DaemonSnapshot['preferences']) => void;
  hydrateCache: (cache: MobileSessionCache) => void;
  exportCache: () => MobileSessionCache | null;
  selectThread: (workspaceId: string, threadId: string) => void;
  selectWorkspace: (workspaceId: string) => void;
  selectNewThread: (workspaceId: string) => void;
  applyThreadHandle: (handle: ThreadHandle) => void;
  applyThreadSummary: (thread: ThreadSummary) => void;
  setThreadDetail: (
    detail: ThreadDetail | null,
    options?: { mergeMode?: ThreadDetailMergeMode },
  ) => void;
  setThreadDetailError: (threadId: string, message: string | null) => void;
  /** Inserts a client-local (optimistic) item until the daemon echoes it. */
  upsertLocalThreadItem: (threadId: string, item: ConversationItem) => void;
  /** Removes a client-local item again (send failed or was queued). */
  removeLocalThreadItem: (threadId: string, itemId: string) => void;
  reconcileSelection: () => void;
  reset: (options?: { preserveCache?: boolean; preserveSelection?: boolean }) => void;
}

type SessionStore = SessionState & SessionActions;

const initialState: SessionState = {
  snapshot: null,
  selectedWorkspaceId: null,
  selectedThreadId: null,
  threadItems: {},
  threadHistory: {},
  threadDetail: null,
  threadDetailErrors: {},
};

const EMPTY_ITEMS: ConversationItem[] = [];
const EMPTY_HISTORY: ThreadHistoryState = {
  hasOlder: false,
  oldestItemId: null,
  newestItemId: null,
  isPartial: false,
};

function filterActiveSnapshot(snapshot: DaemonSnapshot | null): DaemonSnapshot | null {
  if (!snapshot) return null;

  const threads = snapshot.threads.filter((thread) => !thread.is_archived);
  const visibleThreadIds = new Set(threads.map((thread) => thread.id));

  return {
    ...snapshot,
    workspaces: snapshot.workspaces.map((workspace) => ({
      ...workspace,
      current_thread_id:
        workspace.current_thread_id && visibleThreadIds.has(workspace.current_thread_id)
          ? workspace.current_thread_id
          : null,
    })),
    threads,
    interactive_requests: snapshot.interactive_requests.filter(
      (request) => !request.thread_id || visibleThreadIds.has(request.thread_id),
    ),
  };
}

function historyStateForItems(
  items: ConversationItem[],
  fallback: Partial<ThreadHistoryState> = {},
): ThreadHistoryState {
  return {
    hasOlder: fallback.hasOlder ?? false,
    oldestItemId: items[0]?.id ?? fallback.oldestItemId ?? null,
    newestItemId: items.at(-1)?.id ?? fallback.newestItemId ?? null,
    isPartial: fallback.isPartial ?? false,
  };
}

function pruneThreadRecord<T>(
  record: Record<string, T>,
  visibleThreadIds: Set<string>,
): Record<string, T> {
  const entries = Object.entries(record).filter(([threadId]) => visibleThreadIds.has(threadId));
  return entries.length === Object.keys(record).length ? record : Object.fromEntries(entries);
}

function reconcileThreadDetail(
  detail: ThreadDetail | null,
  mergedItems: ConversationItem[],
  history: ThreadHistoryState,
): ThreadDetail | null {
  if (!detail) return null;
  return {
    ...detail,
    items: mergedItems,
    has_older: history.hasOlder,
    oldest_item_id: history.oldestItemId,
    newest_item_id: history.newestItemId,
    is_partial: history.isPartial,
  };
}

function buildCacheFromState(state: SessionState): MobileSessionCache | null {
  const snapshot = filterActiveSnapshot(state.snapshot);
  if (!snapshot) return null;

  const visibleThreadIds = new Set(snapshot.threads.map((thread) => thread.id));
  const orderedThreadIds = [
    state.selectedThreadId,
    ...snapshot.threads.map((thread) => thread.id),
  ].filter((threadId): threadId is string => !!threadId && visibleThreadIds.has(threadId));
  const recentThreadIds = [...new Set(orderedThreadIds)].slice(0, MAX_CACHED_THREADS);

  const threadHistories = Object.fromEntries(
    recentThreadIds.flatMap((threadId) => {
      // Optimistic user messages are client-local until the daemon echoes
      // them; a persisted copy would resurrect as a phantom message after a
      // relaunch if the send never landed.
      const items = (state.threadItems[threadId] ?? []).filter(
        (item) => !(item.kind === 'user_message' && item.pending === true),
      );
      if (items.length === 0) return [];

      const cachedItems =
        items.length > MAX_CACHED_ITEMS ? items.slice(items.length - MAX_CACHED_ITEMS) : items;
      const existingHistory = state.threadHistory[threadId] ?? EMPTY_HISTORY;
      const hasOlder = existingHistory.hasOlder || cachedItems.length < items.length;
      const isPartial = existingHistory.isPartial || cachedItems.length < items.length;

      return [
        [
          threadId,
          {
            thread_id: threadId,
            items: cachedItems,
            has_older: hasOlder,
            oldest_item_id: cachedItems[0]?.id ?? null,
            newest_item_id: cachedItems.at(-1)?.id ?? null,
            is_partial: isPartial,
            updated_at: new Date().toISOString(),
          } satisfies CachedThreadHistory,
        ] as const,
      ];
    }),
  );

  return {
    version: MOBILE_SESSION_CACHE_VERSION,
    snapshot,
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedThreadId: state.selectedThreadId,
    recentThreadIds,
    threadHistories,
  };
}

// Streaming turns persist the cache after every applied event batch;
// serializing the full cache to MMKV that often is wasteful. Throttle writes
// to at most one per second, with a trailing write so the latest state still
// lands after a burst.
const CACHE_PERSIST_THROTTLE_MS = 1_000;
let lastCachePersistAt = 0;
let trailingCachePersistTimer: ReturnType<typeof setTimeout> | null = null;

/** Test-only: make the next persist write through immediately. */
export function __resetSessionCachePersistThrottleForTests(): void {
  if (trailingCachePersistTimer) {
    clearTimeout(trailingCachePersistTimer);
    trailingCachePersistTimer = null;
  }
  lastCachePersistAt = 0;
}

function writeStateCache(state: SessionState) {
  const cache = buildCacheFromState(state);
  // A null cache just means there is no snapshot to derive one from (e.g.
  // right after a truncation reset). Deleting the persisted cache here would
  // defeat reset({ preserveCache: true }); explicit clearing goes through
  // clearMobileSessionCache instead.
  if (!cache) return;
  lastCachePersistAt = Date.now();
  persistMobileSessionCache(cache);
}

/**
 * Flush the latest snapshot-backed cache before a relay cursor is
 * checkpointed. Cursor persistence is an acknowledgement: after a restart,
 * the cache must be able to reconstruct every update at or below that cursor.
 */
export function persistSessionCacheNow(): void {
  if (trailingCachePersistTimer) {
    clearTimeout(trailingCachePersistTimer);
    trailingCachePersistTimer = null;
  }
  writeStateCache(useSessionStore.getState());
}

function persistStateCache(state: SessionState) {
  const elapsed = Date.now() - lastCachePersistAt;
  if (elapsed >= CACHE_PERSIST_THROTTLE_MS) {
    writeStateCache(state);
    return;
  }
  if (trailingCachePersistTimer) return;
  trailingCachePersistTimer = setTimeout(() => {
    trailingCachePersistTimer = null;
    writeStateCache(useSessionStore.getState());
  }, CACHE_PERSIST_THROTTLE_MS - elapsed);
}

function applyEventsToState(state: SessionState, events: EventEnvelope[]): SessionState {
  if (events.length === 0) return state;

  let nextSnapshot = state.snapshot;
  let nextThreadItems = state.threadItems;
  let nextThreadHistory = state.threadHistory;
  let nextThreadDetail = state.threadDetail;
  let nextThreadDetailErrors = state.threadDetailErrors;

  const conversationEventsByThread = new Map<string, EventEnvelope[]>();

  for (const event of events) {
    let candidateSnapshot = applySnapshotEvent(nextSnapshot, event);
    if (!candidateSnapshot && event.event.type === 'snapshot') {
      candidateSnapshot = normalizeDaemonSnapshot(event.event.snapshot);
    }
    if (candidateSnapshot) {
      nextSnapshot = filterActiveSnapshot(candidateSnapshot);
    }

    const daemonEvent = event.event;
    if (
      event.thread_id &&
      (daemonEvent.type === 'conversation-item-added' ||
        daemonEvent.type === 'conversation-item-updated' ||
        daemonEvent.type === 'realtime-item-added' ||
        daemonEvent.type === 'text')
    ) {
      const threadEvents = conversationEventsByThread.get(event.thread_id) ?? [];
      threadEvents.push(event);
      conversationEventsByThread.set(event.thread_id, threadEvents);
    }
  }

  for (const [threadId, threadEvents] of conversationEventsByThread) {
    const existingItems = nextThreadItems[threadId] ?? EMPTY_ITEMS;
    const mergedItems = applyConversationEventsToItems(existingItems, threadEvents);
    if (mergedItems === existingItems) continue;
    const existingHistory = nextThreadHistory[threadId] ?? EMPTY_HISTORY;
    const nextHistory = historyStateForItems(mergedItems, existingHistory);

    nextThreadItems = { ...nextThreadItems, [threadId]: mergedItems };
    nextThreadHistory = { ...nextThreadHistory, [threadId]: nextHistory };

    if (nextThreadDetail?.thread.id === threadId) {
      nextThreadDetail = reconcileThreadDetail(nextThreadDetail, mergedItems, nextHistory);
    }
  }

  if (nextSnapshot) {
    const visibleThreadIds = new Set(nextSnapshot.threads.map((thread) => thread.id));
    nextThreadItems = pruneThreadRecord(nextThreadItems, visibleThreadIds);
    nextThreadHistory = pruneThreadRecord(nextThreadHistory, visibleThreadIds);
    nextThreadDetailErrors = pruneThreadRecord(nextThreadDetailErrors, visibleThreadIds);
    if (nextThreadDetail && !visibleThreadIds.has(nextThreadDetail.thread.id)) {
      nextThreadDetail = null;
    }
  }

  // preserveEmptyThreadSelection: a null thread id here is the new-conversation
  // draft. Without it, every streamed event from a busy thread re-selects that
  // thread and its transcript takes over the draft screen.
  const nextSelection = reconcileSnapshotSelection(
    nextSnapshot ?? state.snapshot,
    state.selectedWorkspaceId,
    state.selectedThreadId,
    { preserveEmptyThreadSelection: true },
  );
  const reconciledThreadDetail =
    nextThreadDetail?.thread.id === nextSelection.threadId ? nextThreadDetail : null;

  return {
    snapshot: nextSnapshot ?? state.snapshot,
    threadItems: nextThreadItems,
    threadHistory: nextThreadHistory,
    threadDetail: reconciledThreadDetail,
    threadDetailErrors: nextThreadDetailErrors,
    selectedWorkspaceId: nextSelection.workspaceId,
    selectedThreadId: nextSelection.threadId,
  };
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  ...initialState,

  applyDaemonEvent: (event) => {
    set((state) => applyEventsToState(state, [event]));
    persistStateCache(get());
  },

  applyDaemonEvents: (events) => {
    if (events.length === 0) return;
    set((state) => applyEventsToState(state, events));
    persistStateCache(get());
  },

  setPreferences: (preferences) => {
    set((state) => (state.snapshot ? { snapshot: { ...state.snapshot, preferences } } : state));
    persistStateCache(get());
  },

  hydrateCache: (cache) => {
    const snapshot = filterActiveSnapshot(normalizeDaemonSnapshot(cache.snapshot));
    const visibleThreadIds = new Set(snapshot?.threads.map((thread) => thread.id) ?? []);
    const cachedThreadHistories = Object.entries(cache.threadHistories ?? {}).filter(([threadId]) =>
      visibleThreadIds.has(threadId),
    );
    const threadItems = Object.fromEntries(
      cachedThreadHistories.map(([threadId, history]) => [
        threadId,
        history.items.map(normalizeConversationItem),
      ]),
    );
    const threadHistory = Object.fromEntries(
      cachedThreadHistories.map(([threadId, history]) => [
        threadId,
        {
          hasOlder: history.has_older,
          oldestItemId: history.oldest_item_id ?? history.items[0]?.id ?? null,
          newestItemId: history.newest_item_id ?? history.items.at(-1)?.id ?? null,
          isPartial: history.is_partial,
        } satisfies ThreadHistoryState,
      ]),
    );
    const nextSelection = reconcileSnapshotSelection(
      snapshot,
      cache.selectedWorkspaceId,
      cache.selectedThreadId,
      { preserveEmptyThreadSelection: true },
    );

    set({
      snapshot,
      selectedWorkspaceId: nextSelection.workspaceId,
      selectedThreadId: nextSelection.threadId,
      threadItems,
      threadHistory,
      threadDetail: null,
      threadDetailErrors: {},
    });
    persistStateCache(get());
  },

  exportCache: () => buildCacheFromState(get()),

  selectThread: (workspaceId, threadId) => {
    set((state) => ({
      selectedWorkspaceId: workspaceId,
      selectedThreadId: threadId,
      threadDetail: state.threadDetail?.thread.id === threadId ? state.threadDetail : null,
    }));
    persistStateCache(get());
  },

  selectWorkspace: (workspaceId) => {
    const { snapshot } = get();
    const workspace = snapshot?.workspaces.find((entry) => entry.id === workspaceId);
    const threadId = workspace?.current_thread_id ?? null;
    set((state) => ({
      selectedWorkspaceId: workspaceId,
      selectedThreadId: threadId,
      threadDetail: state.threadDetail?.thread.id === threadId ? state.threadDetail : null,
    }));
    persistStateCache(get());
  },

  selectNewThread: (workspaceId) => {
    set({
      selectedWorkspaceId: workspaceId,
      selectedThreadId: null,
      threadDetail: null,
    });
    persistStateCache(get());
  },

  applyThreadHandle: (handle) => {
    set((state) => ({
      snapshot: state.snapshot
        ? {
            ...state.snapshot,
            workspaces: state.snapshot.workspaces.map((workspace) =>
              workspace.id === handle.workspace.id ? handle.workspace : workspace,
            ),
            threads: [
              handle.thread,
              ...state.snapshot.threads.filter((thread) => thread.id !== handle.thread.id),
            ],
          }
        : state.snapshot,
    }));
    persistStateCache(get());
  },

  applyThreadSummary: (thread) => {
    set((state) => {
      if (!state.snapshot?.threads.some((entry) => entry.id === thread.id)) {
        return state;
      }
      return {
        snapshot: {
          ...state.snapshot,
          threads: state.snapshot.threads.map((entry) =>
            entry.id === thread.id ? thread : entry,
          ),
        },
        threadDetail:
          state.threadDetail?.thread.id === thread.id
            ? { ...state.threadDetail, thread }
            : state.threadDetail,
      };
    });
    persistStateCache(get());
  },

  setThreadDetail: (detail, options) => {
    if (!detail) {
      set({ threadDetail: null });
      persistStateCache(get());
      return;
    }

    set((state) => {
      const threadId = detail.thread.id;
      const existingItems = state.threadItems[threadId] ?? EMPTY_ITEMS;
      const mergeMode = options?.mergeMode ?? 'refresh';
      const existingHistory = state.threadHistory[threadId] ?? EMPTY_HISTORY;
      const currentDetail =
        existingItems.length > 0
          ? {
              ...detail,
              items: existingItems,
              has_older: existingHistory.hasOlder,
              oldest_item_id: existingHistory.oldestItemId,
              newest_item_id: existingHistory.newestItemId,
              is_partial: existingHistory.isPartial,
            }
          : null;
      const mergedDetail = mergeThreadDetailPage(currentDetail, detail, mergeMode);
      const mergedItems = mergedDetail.items;
      const nextHistory = historyStateForItems(mergedItems, {
        hasOlder: mergedDetail.has_older,
        oldestItemId: mergedDetail.oldest_item_id,
        newestItemId: mergedDetail.newest_item_id,
        isPartial: mergedDetail.is_partial,
      });
      const isSelectedThread = state.selectedThreadId === threadId;

      return {
        threadDetail: isSelectedThread ? mergedDetail : state.threadDetail,
        threadItems: { ...state.threadItems, [threadId]: mergedItems },
        threadHistory: { ...state.threadHistory, [threadId]: nextHistory },
        threadDetailErrors: state.threadDetailErrors[threadId]
          ? Object.fromEntries(
              Object.entries(state.threadDetailErrors).filter(([id]) => id !== threadId),
            )
          : state.threadDetailErrors,
      };
    });
    persistStateCache(get());
  },

  setThreadDetailError: (threadId, message) => {
    set((state) => {
      if (!message) {
        if (!state.threadDetailErrors[threadId]) return state;
        return {
          threadDetailErrors: Object.fromEntries(
            Object.entries(state.threadDetailErrors).filter(([id]) => id !== threadId),
          ),
        };
      }
      if (state.threadDetailErrors[threadId] === message) return state;
      return { threadDetailErrors: { ...state.threadDetailErrors, [threadId]: message } };
    });
  },

  upsertLocalThreadItem: (threadId, item) => {
    set((state) => {
      const existingItems = state.threadItems[threadId] ?? EMPTY_ITEMS;
      const mergedItems = upsertConversationItem(existingItems, item);
      const nextHistory = historyStateForItems(
        mergedItems,
        state.threadHistory[threadId] ?? EMPTY_HISTORY,
      );
      return {
        threadItems: { ...state.threadItems, [threadId]: mergedItems },
        threadHistory: { ...state.threadHistory, [threadId]: nextHistory },
        threadDetail:
          state.threadDetail?.thread.id === threadId
            ? reconcileThreadDetail(state.threadDetail, mergedItems, nextHistory)
            : state.threadDetail,
      };
    });
    persistStateCache(get());
  },

  removeLocalThreadItem: (threadId, itemId) => {
    set((state) => {
      const existingItems = state.threadItems[threadId] ?? EMPTY_ITEMS;
      const mergedItems = removeConversationItem(existingItems, itemId);
      if (mergedItems === existingItems) return state;
      const nextHistory = historyStateForItems(
        mergedItems,
        state.threadHistory[threadId] ?? EMPTY_HISTORY,
      );
      return {
        threadItems: { ...state.threadItems, [threadId]: mergedItems },
        threadHistory: { ...state.threadHistory, [threadId]: nextHistory },
        threadDetail:
          state.threadDetail?.thread.id === threadId
            ? reconcileThreadDetail(state.threadDetail, mergedItems, nextHistory)
            : state.threadDetail,
      };
    });
    persistStateCache(get());
  },

  reconcileSelection: () => {
    set((state) => {
      const next = reconcileSnapshotSelection(
        state.snapshot,
        state.selectedWorkspaceId,
        state.selectedThreadId,
        { preserveEmptyThreadSelection: true },
      );
      return {
        selectedWorkspaceId: next.workspaceId,
        selectedThreadId: next.threadId,
        threadDetail:
          state.threadDetail?.workspace.id === next.workspaceId &&
          state.threadDetail.thread.id === next.threadId
            ? state.threadDetail
            : null,
      };
    });
    persistStateCache(get());
  },

  reset: (options) => {
    const previous = get();
    set({
      ...initialState,
      selectedWorkspaceId: options?.preserveSelection
        ? previous.selectedWorkspaceId
        : initialState.selectedWorkspaceId,
      selectedThreadId: options?.preserveSelection
        ? previous.selectedThreadId
        : initialState.selectedThreadId,
    });
    // Drop any throttled trailing write: it would persist (or, before the
    // null-cache guard, delete) a cache derived from the cleared state.
    if (trailingCachePersistTimer) {
      clearTimeout(trailingCachePersistTimer);
      trailingCachePersistTimer = null;
    }
    // A relay history truncation only needs derived state rebuilt; wiping the
    // offline cache would blank the UI until the next snapshot arrives.
    if (!options?.preserveCache) {
      clearMobileSessionCache();
    }
  },
}));

// The composer keys unsent drafts/attachments by conversation; follow every
// selection change (taps, snapshot reconciles, cache hydration) so its
// current-draft mirror always matches the thread on screen.
useSessionStore.subscribe((state, previous) => {
  if (
    state.selectedWorkspaceId !== previous.selectedWorkspaceId ||
    state.selectedThreadId !== previous.selectedThreadId
  ) {
    useUIStore.getState().setConversation(state.selectedWorkspaceId, state.selectedThreadId);
  }
});

const EMPTY_WORKSPACES: DaemonSnapshot['workspaces'] = [];
const EMPTY_THREADS: DaemonSnapshot['threads'] = [];

/* v8 ignore start */
export function useGroups() {
  // Narrow, shallow subscriptions: conversation-item events change the store
  // on every streamed chunk but leave these arrays' elements alone, and
  // re-deriving groups for each chunk made the whole sidebar re-render and
  // flicker while any thread was working.
  const workspaces = useSessionStore(useShallow((s) => s.snapshot?.workspaces ?? EMPTY_WORKSPACES));
  const threads = useSessionStore(useShallow((s) => s.snapshot?.threads ?? EMPTY_THREADS));
  const workspaceOrder = useSessionStore((s) => s.snapshot?.preferences.workspace_order);
  return useMemo(
    () => buildProjectGroups(workspaces, threads, workspaceOrder),
    [threads, workspaceOrder, workspaces],
  );
}

export function useSelectedWorkspace() {
  return useSessionStore(
    (s) => s.snapshot?.workspaces.find((w) => w.id === s.selectedWorkspaceId) ?? null,
  );
}

export function useSelectedThread() {
  return useSessionStore((s) =>
    threadForSelection(
      s.snapshot?.threads ?? EMPTY_THREADS,
      s.selectedWorkspaceId,
      s.selectedThreadId,
    ),
  );
}

export function useSelectedThreadHistory() {
  return useSessionStore((s) => {
    const selectedThreadId = s.selectedThreadId;
    if (
      !selectedThreadId ||
      !threadForSelection(
        s.snapshot?.threads ?? EMPTY_THREADS,
        s.selectedWorkspaceId,
        selectedThreadId,
      )
    )
      return EMPTY_HISTORY;
    return s.threadHistory[selectedThreadId] ?? EMPTY_HISTORY;
  });
}

export function useSelectedThreadDetailError() {
  return useSessionStore((s) =>
    s.selectedThreadId ? (s.threadDetailErrors[s.selectedThreadId] ?? null) : null,
  );
}

export function useConversationItems() {
  const selectedItems = useSessionStore(
    useShallow((s) => {
      const selectedThread = threadForSelection(
        s.snapshot?.threads ?? EMPTY_THREADS,
        s.selectedWorkspaceId,
        s.selectedThreadId,
      );
      if (!selectedThread) return EMPTY_ITEMS;
      if (
        s.threadDetail &&
        s.threadDetail.workspace.id === s.selectedWorkspaceId &&
        s.threadDetail.thread.id === selectedThread.id
      )
        return s.threadDetail.items;
      if (s.selectedThreadId) return s.threadItems[s.selectedThreadId] ?? EMPTY_ITEMS;
      return EMPTY_ITEMS;
    }),
  );
  const pendingNewThreadItem = useUIStore((state) =>
    state.pendingNewThreadItem?.conversationKey === state.conversationKey
      ? state.pendingNewThreadItem.item
      : null,
  );
  return selectedItems.length > 0 || !pendingNewThreadItem ? selectedItems : [pendingNewThreadItem];
}

/** Subscribes to a primitive, so transcript rows reading it only re-render
    when the preference itself changes — not on every streamed item. */
export function useThinkingDisplay(): ThinkingDisplay {
  return useSessionStore((s) => s.snapshot?.preferences.conversation.thinking_display ?? 'auto');
}

/** Same primitive subscription as `useThinkingDisplay`, for the same reason.
    Older daemons omit the field; absent means the shipped default, on. */
export function useCollapseLongUserMessages(): boolean {
  return useSessionStore(
    (s) => s.snapshot?.preferences.conversation.collapse_long_user_messages ?? true,
  );
}

export function useInteractiveRequests() {
  return useSessionStore(
    useShallow((s) =>
      s.selectedWorkspaceId && s.selectedThreadId
        ? (s.snapshot?.interactive_requests ?? []).filter(
            (a) => a.workspace_id === s.selectedWorkspaceId && a.thread_id === s.selectedThreadId,
          )
        : [],
    ),
  );
}

/** @deprecated Use the accurately named `useInteractiveRequests`. */
export const useApprovals = useInteractiveRequests;
/* v8 ignore stop */
