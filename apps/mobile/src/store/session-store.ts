/**
 * Session store — daemon snapshot, threads, conversation items.
 *
 * Consumes decrypted daemon events from the relay connection and
 * maintains the same state shape as the desktop/remote-web apps,
 * plus a mobile-only cache of recent thread history windows.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

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
/**
 * Threads kept in the cached snapshot. Deep enough that every project in the
 * sidebar still has its recent conversations offline, far short of the
 * thousands a long-lived daemon accumulates. The selected thread and each
 * workspace's current thread are kept regardless of where they fall.
 */
const MAX_CACHED_SNAPSHOT_THREADS = 200;

type ThreadDetailMergeMode = 'refresh' | 'prepend';

export interface ThreadHistoryState {
  hasOlder: boolean;
  oldestItemId: string | null;
  newestItemId: string | null;
  isPartial: boolean;
}

/** Enough to put a thread back if an optimistic archive RPC fails. */
export type ThreadArchiveUndo = {
  thread: ThreadSummary;
  index: number;
  workspaceCurrentThreadId: string | null;
  interactiveRequests: DaemonSnapshot['interactive_requests'];
  selectedWorkspaceId: string | null;
  selectedThreadId: string | null;
  threadDetail: ThreadDetail | null;
  threadItems: ConversationItem[] | undefined;
  threadHistory: ThreadHistoryState | undefined;
  threadDetailError: string | undefined;
  postSelectedThreadId: string | null;
};

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
  /** Drops the thread from the sidebar immediately; restore with the undo. */
  archiveThreadLocally: (threadId: string) => ThreadArchiveUndo | null;
  restoreArchivedThread: (undo: ThreadArchiveUndo) => void;
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

function shallowEqualFields<T extends Record<string, unknown>>(a: T, b: T): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => key in b && a[key] === b[key]);
}

/**
 * Returns `prev` itself when a freshly built list holds identical element
 * references in identical order — sparing downstream shallow compares
 * (`useGroups`, drawer subscriptions) from treating every snapshot event as
 * a change.
 */
function reuseIfIdentical<T>(built: T[], prev: T[] | undefined): T[] {
  if (
    prev &&
    prev.length === built.length &&
    prev.every((item, index) => item === built[index])
  ) {
    return prev;
  }
  return built;
}

/**
 * Live (non-archived) thread lists, keyed by the array that produced them. A
 * streaming turn pushes a freshly built threads array through here for every
 * chunk, and nearly all of them hold no archived thread at all — the scan
 * below short-circuits on the first one it finds, and the result is reused so
 * repeat calls for the same array (snapshot apply, then the cache builder)
 * cost nothing. Archived chats stay in the snapshot for the sidebar restore
 * list; this helper is only for current-thread pointers and approvals.
 */
const liveThreadsCache = new WeakMap<object, DaemonSnapshot['threads']>();

function liveThreads(threads: DaemonSnapshot['threads']): DaemonSnapshot['threads'] {
  const cached = liveThreadsCache.get(threads);
  if (cached) return cached;
  const filtered = threads.some((thread) => thread.is_archived)
    ? threads.filter((thread) => !thread.is_archived)
    : threads;
  liveThreadsCache.set(threads, filtered);
  if (filtered !== threads) liveThreadsCache.set(filtered, filtered);
  return filtered;
}

const visibleThreadIdCache = new WeakMap<object, Set<string>>();

function visibleThreadIdsOf(threads: DaemonSnapshot['threads']): Set<string> {
  const cached = visibleThreadIdCache.get(threads);
  if (cached) return cached;
  const ids = new Set(threads.map((thread) => thread.id));
  visibleThreadIdCache.set(threads, ids);
  return ids;
}

function filterActiveSnapshot(
  snapshot: DaemonSnapshot | null,
  /**
   * Previous filtered snapshot, when one exists. Unchanged workspaces are
   * reused by reference so per-event spread copies do not defeat shallow
   * equality downstream.
   */
  prevSnapshot?: DaemonSnapshot | null,
): DaemonSnapshot | null {
  if (!snapshot) return null;
  if (snapshot === prevSnapshot) return prevSnapshot;

  const live = liveThreads(snapshot.threads);
  const liveThreadIds = visibleThreadIdsOf(live);
  const threads = snapshot.threads;

  // The common streaming event replaces one thread summary in place: the
  // workspaces array keeps its identity and every workspace pointer still
  // resolves, so the whole per-workspace rebuild below (a spread and a
  // field-by-field compare each) is redundant. Validating the pointers is a
  // pass over the handful of workspaces rather than over every thread, so
  // this stays exact — a workspace whose current thread just disappeared
  // still falls through to the rebuild.
  if (
    prevSnapshot &&
    snapshot.workspaces === prevSnapshot.workspaces &&
    snapshot.workspaces.every(
      (workspace) =>
        !workspace.current_thread_id || liveThreadIds.has(workspace.current_thread_id),
    )
  ) {
    return {
      ...snapshot,
      workspaces: prevSnapshot.workspaces,
      threads: reuseIfIdentical(threads, prevSnapshot.threads),
      interactive_requests:
        snapshot.interactive_requests === prevSnapshot.interactive_requests
          ? prevSnapshot.interactive_requests
          : reuseIfIdentical(
              snapshot.interactive_requests.filter(
                (request) => !request.thread_id || liveThreadIds.has(request.thread_id),
              ),
              prevSnapshot.interactive_requests,
            ),
    };
  }

  const prevWorkspacesById = prevSnapshot
    ? new Map(prevSnapshot.workspaces.map((workspace) => [workspace.id, workspace]))
    : null;

  // Rebuild each workspace's visible-thread pointer, then keep the PREVIOUS
  // object whenever every field matches — object identity, not just shape,
  // is what consumers compare.
  let rebuiltWorkspaces = snapshot.workspaces.map((workspace) => {
    const candidate = {
      ...workspace,
      current_thread_id:
        workspace.current_thread_id && liveThreadIds.has(workspace.current_thread_id)
          ? workspace.current_thread_id
          : null,
    };
    const previous = prevWorkspacesById?.get(workspace.id);
    if (previous && shallowEqualFields(candidate as Record<string, unknown>, previous as Record<string, unknown>)) {
      return previous;
    }
    return candidate;
  });
  rebuiltWorkspaces = reuseIfIdentical(rebuiltWorkspaces, prevSnapshot?.workspaces);

  return {
    ...snapshot,
    workspaces: rebuiltWorkspaces,
    threads: reuseIfIdentical(threads, prevSnapshot?.threads),
    interactive_requests: reuseIfIdentical(
      snapshot.interactive_requests.filter(
        (request) => !request.thread_id || liveThreadIds.has(request.thread_id),
      ),
      prevSnapshot?.interactive_requests,
    ),
  };
}

function captureThreadArchiveUndo(
  state: SessionState,
  threadId: string,
): ThreadArchiveUndo | null {
  const snapshot = state.snapshot;
  if (!snapshot) return null;
  const index = snapshot.threads.findIndex((thread) => thread.id === threadId);
  if (index < 0) return null;
  const thread = snapshot.threads[index]!;
  if (thread.is_archived) return null;
  const workspace = snapshot.workspaces.find((entry) => entry.id === thread.workspace_id);
  return {
    thread,
    index,
    workspaceCurrentThreadId: workspace?.current_thread_id ?? null,
    interactiveRequests: snapshot.interactive_requests.filter(
      (request) => request.thread_id === threadId,
    ),
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedThreadId: state.selectedThreadId,
    threadDetail: state.threadDetail,
    threadItems: state.threadItems[threadId],
    threadHistory: state.threadHistory[threadId],
    threadDetailError: state.threadDetailErrors[threadId],
    postSelectedThreadId: state.selectedThreadId,
  };
}

function dropArchivedThread(state: SessionState, threadId: string): SessionState | null {
  if (!state.snapshot?.threads.some((thread) => thread.id === threadId)) return null;
  const nextSnapshot = filterActiveSnapshot(
    {
      ...state.snapshot,
      threads: state.snapshot.threads.map((thread) =>
        thread.id === threadId ? { ...thread, is_archived: true } : thread,
      ),
    },
    state.snapshot,
  )!;

  const liveThreadIds = new Set(
    liveThreads(nextSnapshot.threads).map((thread) => thread.id),
  );
  const nextThreadItems = pruneThreadRecord(state.threadItems, liveThreadIds);
  const nextThreadHistory = pruneThreadRecord(state.threadHistory, liveThreadIds);
  const nextThreadDetailErrors = pruneThreadRecord(state.threadDetailErrors, liveThreadIds);
  let nextThreadDetail =
    state.threadDetail && liveThreadIds.has(state.threadDetail.thread.id)
      ? state.threadDetail
      : null;
  const nextSelection = reconcileSnapshotSelection(
    { ...nextSnapshot, threads: liveThreads(nextSnapshot.threads) },
    state.selectedWorkspaceId,
    state.selectedThreadId,
    { preserveEmptyThreadSelection: true },
  );
  nextThreadDetail =
    nextThreadDetail?.thread.id === nextSelection.threadId ? nextThreadDetail : null;

  return {
    ...state,
    snapshot: nextSnapshot,
    threadItems: nextThreadItems,
    threadHistory: nextThreadHistory,
    threadDetail: nextThreadDetail,
    threadDetailErrors: nextThreadDetailErrors,
    selectedWorkspaceId: nextSelection.workspaceId,
    selectedThreadId: nextSelection.threadId,
  };
}

function restoreArchivedThreadState(
  state: SessionState,
  undo: ThreadArchiveUndo,
): SessionState {
  if (!state.snapshot) return state;
  const existingIndex = state.snapshot.threads.findIndex(
    (thread) => thread.id === undo.thread.id,
  );
  const threads = [...state.snapshot.threads];
  if (existingIndex >= 0) {
    threads[existingIndex] = undo.thread;
  } else {
    threads.splice(Math.min(undo.index, threads.length), 0, undo.thread);
  }

  const workspaces = state.snapshot.workspaces.map((workspace) =>
    workspace.id === undo.thread.workspace_id
      ? { ...workspace, current_thread_id: undo.workspaceCurrentThreadId }
      : workspace,
  );

  const existingRequestIds = new Set(
    state.snapshot.interactive_requests.map((request) => request.request_id),
  );
  const interactive_requests = [
    ...undo.interactiveRequests.filter(
      (request) => !existingRequestIds.has(request.request_id),
    ),
    ...state.snapshot.interactive_requests,
  ];

  const restoreSelection = state.selectedThreadId === undo.postSelectedThreadId;

  let threadItems = state.threadItems;
  if (undo.threadItems && !threadItems[undo.thread.id]) {
    threadItems = { ...threadItems, [undo.thread.id]: undo.threadItems };
  }
  let threadHistory = state.threadHistory;
  if (undo.threadHistory && !threadHistory[undo.thread.id]) {
    threadHistory = { ...threadHistory, [undo.thread.id]: undo.threadHistory };
  }
  let threadDetailErrors = state.threadDetailErrors;
  if (undo.threadDetailError && !threadDetailErrors[undo.thread.id]) {
    threadDetailErrors = {
      ...threadDetailErrors,
      [undo.thread.id]: undo.threadDetailError,
    };
  }

  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      threads,
      workspaces,
      interactive_requests,
    },
    threadItems,
    threadHistory,
    threadDetailErrors,
    selectedWorkspaceId: restoreSelection
      ? undo.selectedWorkspaceId
      : state.selectedWorkspaceId,
    selectedThreadId: restoreSelection ? undo.selectedThreadId : state.selectedThreadId,
    threadDetail: restoreSelection ? undo.threadDetail : state.threadDetail,
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

/**
 * Trims the snapshot down to what the offline cache actually renders before it
 * is serialized, encrypted and written.
 *
 * The daemon's snapshot is dominated by two things the cache has no use for:
 * skill catalogs (duplicated per workspace and again per agent — megabytes of
 * the payload) and the full thread list, which can run to thousands of entries
 * while the sidebar shows a few dozen. Both are re-supplied by the
 * authoritative snapshot moments after launch, and the composer's skill list
 * is refreshed by its own `workspace.skills` RPC, so dropping them costs a
 * cold start nothing and takes the recurring encrypt-and-write cost down with
 * the byte count.
 */
function cacheableSnapshot(
  snapshot: DaemonSnapshot,
  selectedThreadId: string | null,
): DaemonSnapshot {
  const keptThreadIds = new Set<string>();
  if (selectedThreadId) keptThreadIds.add(selectedThreadId);
  for (const workspace of snapshot.workspaces) {
    if (workspace.current_thread_id) keptThreadIds.add(workspace.current_thread_id);
  }

  const threads =
    snapshot.threads.length > MAX_CACHED_SNAPSHOT_THREADS
      ? snapshot.threads.filter(
          (thread, index) =>
            index < MAX_CACHED_SNAPSHOT_THREADS || keptThreadIds.has(thread.id),
        )
      : snapshot.threads;

  return {
    ...snapshot,
    threads,
    workspaces: snapshot.workspaces.map((workspace) => {
      const { skills: _skills, ...rest } = workspace;
      return {
        ...rest,
        // Both of these are the same catalog repeated for every agent of every
        // workspace, and between them they are the largest thing in here. The
        // composer reads models through its own per-workspace model cache
        // (see loadCachedModels) whenever the snapshot has none, so a cold
        // start still opens with a populated picker.
        agents: (workspace.agents ?? []).map((agent) => {
          const { skills: _agentSkills, ...agentRest } = agent;
          return { ...agentRest, models: [] };
        }),
      };
    }),
  };
}

function buildCacheFromState(state: SessionState): MobileSessionCache | null {
  const filtered = filterActiveSnapshot(state.snapshot, state.snapshot);
  if (!filtered) return null;
  const snapshot = cacheableSnapshot(filtered, state.selectedThreadId);

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

// Streaming turns used to persist the cache after every applied event batch.
// The stringify + JS AES of even a projected snapshot is still too expensive
// to run while tokens are arriving; persist on snapshot, selection, stream
// end, and background instead. Throttle those remaining writes to at most
// one per second, with a trailing write so the latest state still lands.
const CACHE_PERSIST_THROTTLE_MS = 1_000;
let lastCachePersistAt = 0;
let trailingCachePersistTimer: ReturnType<typeof setTimeout> | null = null;
let conversationUpdatesPaused = false;

/**
 * The front drawer completely hides the transcript. While it is open, keep
 * global summaries current but defer the selected transcript to the
 * authoritative thread.detail refresh that runs when the drawer closes.
 */
export function setConversationUpdatesPaused(paused: boolean): void {
  conversationUpdatesPaused = paused;
}

/**
 * The state a write was last derived from. Every field the cache reads is
 * replaced wholesale rather than mutated, so identity is a sound (and O(1))
 * test for "nothing to write" — and the relay checkpoints a cursor on a
 * timer whether or not anything changed, which otherwise re-encrypts an
 * identical payload every second while the desktop merely ticks.
 */
let lastWrittenCacheInputs: {
  snapshot: SessionState['snapshot'];
  threadItems: SessionState['threadItems'];
  selectedWorkspaceId: string | null;
  selectedThreadId: string | null;
} | null = null;

/** Test-only: make the next persist write through immediately. */
export function __resetSessionCachePersistThrottleForTests(): void {
  if (trailingCachePersistTimer) {
    clearTimeout(trailingCachePersistTimer);
    trailingCachePersistTimer = null;
  }
  lastCachePersistAt = 0;
  lastWrittenCacheInputs = null;
}

function writeStateCache(state: SessionState) {
  const previous = lastWrittenCacheInputs;
  if (
    previous &&
    previous.snapshot === state.snapshot &&
    previous.threadItems === state.threadItems &&
    previous.selectedWorkspaceId === state.selectedWorkspaceId &&
    previous.selectedThreadId === state.selectedThreadId
  ) {
    // Still stamp the clock: the throttle window is about how often we are
    // willing to write, not about how often we were asked.
    lastCachePersistAt = Date.now();
    return;
  }

  const cache = buildCacheFromState(state);
  // A null cache just means there is no snapshot to derive one from.
  // Deleting the persisted cache here would defeat reset({ preserveCache: true });
  // explicit clearing goes through clearMobileSessionCache instead.
  if (!cache) return;
  lastCachePersistAt = Date.now();
  lastWrittenCacheInputs = {
    snapshot: state.snapshot,
    threadItems: state.threadItems,
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedThreadId: state.selectedThreadId,
  };
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

function isStreamingEvent(event: EventEnvelope): boolean {
  const daemonEvent = event.event;
  switch (daemonEvent.type) {
    case 'conversation-item-updated':
    case 'thread-token-usage-updated':
    case 'text':
      return true;
    case 'conversation-item-added': {
      const item = daemonEvent.item;
      return (
        typeof item === 'object' &&
        item !== null &&
        'lifecycle' in item &&
        (item.lifecycle === 'streaming' || item.lifecycle === 'pending')
      );
    }
    case 'thread-updated':
      return daemonEvent.thread.status === 'running';
    default:
      return false;
  }
}

function shouldPersistCacheAfterEvents(events: EventEnvelope[]): boolean {
  return events.some((event) => !isStreamingEvent(event));
}

// Global summaries stay live for status, attention, and the sidebar. Mobile
// retains transcript bodies only for the selected visible thread; every
// selection (and drawer close) refreshes authoritative thread.detail.
function shouldApplyEventToSessionState(
  state: SessionState,
  event: EventEnvelope,
): boolean {
  const daemonEvent = event.event;
  const isConversationContent =
    daemonEvent.type === 'conversation-item-added' ||
    daemonEvent.type === 'conversation-item-updated' ||
    daemonEvent.type === 'realtime-item-added' ||
    daemonEvent.type === 'text';
  if (!isConversationContent) return true;
  return (
    !conversationUpdatesPaused &&
    event.thread_id !== null &&
    event.thread_id === state.selectedThreadId
  );
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

/**
 * Cache persistence for paths that run inside a tap or an RPC continuation
 * (thread selection, detail merges). The full-cache stringify + MMKV write is
 * heavy enough to delay the screen transition those paths are about to
 * trigger, and it is crash-recovery bookkeeping only — so it never writes in
 * the caller's frame. The write always waits a full throttle window, landing
 * after the navigation/render burst and coalescing with any event-driven
 * trailing write already scheduled.
 */
function schedulePersistStateCache() {
  if (trailingCachePersistTimer) return;
  trailingCachePersistTimer = setTimeout(() => {
    trailingCachePersistTimer = null;
    writeStateCache(useSessionStore.getState());
  }, CACHE_PERSIST_THROTTLE_MS);
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
      // Prev is the filtered snapshot accumulated so far in this batch, so
      // per-event workspace spreads stay referentially stable while nothing
      // actually changed.
      nextSnapshot = filterActiveSnapshot(candidateSnapshot, nextSnapshot);
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

  if (nextSnapshot && nextSnapshot.threads !== state.snapshot?.threads) {
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
    let applied = false;
    set((state) => {
      applied = shouldApplyEventToSessionState(state, event);
      return applied ? applyEventsToState(state, [event]) : state;
    });
    if (applied && shouldPersistCacheAfterEvents([event])) persistStateCache(get());
  },

  applyDaemonEvents: (events) => {
    if (events.length === 0) return;
    let appliedEvents = events;
    set((state) => {
      appliedEvents = events.filter((event) =>
        shouldApplyEventToSessionState(state, event),
      );
      return applyEventsToState(state, appliedEvents);
    });
    if (shouldPersistCacheAfterEvents(appliedEvents)) persistStateCache(get());
  },

  setPreferences: (preferences) => {
    set((state) => (state.snapshot ? { snapshot: { ...state.snapshot, preferences } } : state));
    persistStateCache(get());
  },

  hydrateCache: (cache) => {
    const snapshot = filterActiveSnapshot(normalizeDaemonSnapshot(cache.snapshot), get().snapshot);
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
    schedulePersistStateCache();
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
    schedulePersistStateCache();
  },

  selectNewThread: (workspaceId) => {
    set({
      selectedWorkspaceId: workspaceId,
      selectedThreadId: null,
      threadDetail: null,
    });
    schedulePersistStateCache();
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
      const existing = state.snapshot?.threads.find((entry) => entry.id === thread.id);
      if (!existing) {
        return state;
      }
      if (thread.is_archived && !existing.is_archived) {
        return dropArchivedThread(state, thread.id) ?? state;
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

  archiveThreadLocally: (threadId) => {
    let undo: ThreadArchiveUndo | null = null;
    set((state) => {
      const captured = captureThreadArchiveUndo(state, threadId);
      if (!captured) return state;
      const next = dropArchivedThread(state, threadId)!;
      undo = { ...captured, postSelectedThreadId: next.selectedThreadId };
      return next;
    });
    if (undo) persistStateCache(get());
    return undo;
  },

  restoreArchivedThread: (undo) => {
    set((state) => restoreArchivedThreadState(state, undo));
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
    // The RPC continuation that lands here has just decrypted, normalized and
    // merged up to 150 items and is about to derive presentation for all of
    // them; the cache write must not extend that same JS-thread batch.
    schedulePersistStateCache();
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
    const preserveCache = options?.preserveCache === true;
    set({
      ...initialState,
      // Truncation recovery still has to fetch an authoritative snapshot, but
      // the last-known project list (and open transcript) should stay on
      // screen while it does. Wiping them here is what made the sidebar flash
      // a skeleton over cached threads on every reconnect that pruned replay.
      snapshot: preserveCache ? previous.snapshot : initialState.snapshot,
      threadItems: preserveCache ? previous.threadItems : initialState.threadItems,
      threadHistory: preserveCache ? previous.threadHistory : initialState.threadHistory,
      threadDetail: preserveCache ? previous.threadDetail : initialState.threadDetail,
      threadDetailErrors: preserveCache
        ? previous.threadDetailErrors
        : initialState.threadDetailErrors,
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
    // The unchanged-inputs guard must not vouch for a cache this reset is
    // about to delete.
    lastWrittenCacheInputs = null;
    // A relay history truncation only needs derived state rebuilt; wiping the
    // offline cache would blank the UI until the next snapshot arrives.
    if (!preserveCache) {
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

export function useSelectedThreadHistory(options?: { pause?: boolean }) {
  const pause = options?.pause === true;
  const frozenHistory = useRef<ThreadHistoryState | null>(null);
  return useSessionStore((s) => {
    const selectedThreadId = s.selectedThreadId;
    const live = (
      !selectedThreadId ||
      !threadForSelection(
        s.snapshot?.threads ?? EMPTY_THREADS,
        s.selectedWorkspaceId,
        selectedThreadId,
      )
    )
      ? EMPTY_HISTORY
      : (s.threadHistory[selectedThreadId] ?? EMPTY_HISTORY);
    if (!pause) {
      frozenHistory.current = live;
      return live;
    }
    if (frozenHistory.current == null) frozenHistory.current = live;
    return frozenHistory.current;
  });
}

export function useSelectedThreadDetailError() {
  return useSessionStore((s) =>
    s.selectedThreadId ? (s.threadDetailErrors[s.selectedThreadId] ?? null) : null,
  );
}

function selectLiveConversationItems(state: SessionStore): ConversationItem[] {
  const selectedThread = threadForSelection(
    state.snapshot?.threads ?? EMPTY_THREADS,
    state.selectedWorkspaceId,
    state.selectedThreadId,
  );
  if (!selectedThread) return EMPTY_ITEMS;
  if (
    state.threadDetail &&
    state.threadDetail.workspace.id === state.selectedWorkspaceId &&
    state.threadDetail.thread.id === selectedThread.id
  ) {
    return state.threadDetail.items;
  }
  if (state.selectedThreadId) return state.threadItems[state.selectedThreadId] ?? EMPTY_ITEMS;
  return EMPTY_ITEMS;
}

/**
 * Items for the selected thread.
 *
 * `pause` keeps returning the array from the last unpaused snapshot. The
 * drawer covers the transcript but does not unmount it, so without this a
 * streaming turn still re-derives presentation and re-parses Markdown under
 * the sidebar. The store keeps applying events; closing the drawer reads the
 * live items in one paint.
 */
export function useConversationItems(options?: { pause?: boolean }) {
  const pause = options?.pause === true;
  const frozenItems = useRef<ConversationItem[] | null>(null);
  const selectedItems = useSessionStore(
    useShallow((s) => {
      const live = selectLiveConversationItems(s);
      if (!pause) {
        frozenItems.current = live;
        return live;
      }
      if (frozenItems.current == null) frozenItems.current = live;
      return frozenItems.current;
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

/**
 * The snapshot, sampled at most once per `intervalMs`.
 *
 * A streaming turn replaces the snapshot on every applied event batch — up to
 * one per animation frame. Screens that re-derive something expensive from the
 * whole snapshot (the sidebar rebuilds project groups, filters, sorts and rows
 * over every thread) cannot usefully repaint that often, and doing so on the
 * JS thread is what makes a live turn feel like a hot phone. Subscribing here
 * rather than through a selector means the component is not re-rendered at all
 * between samples, and the flush always reads the current store value, so the
 * only cost is up to `intervalMs` of staleness.
 */
export function useThrottledSnapshot(intervalMs: number): DaemonSnapshot | null {
  const [snapshot, setSnapshot] = useState(() => useSessionStore.getState().snapshot);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastFlushedAt = 0;

    const flush = () => {
      timer = null;
      lastFlushedAt = Date.now();
      setSnapshot(useSessionStore.getState().snapshot);
    };

    // Catch up on anything that landed between the render that seeded state
    // and this subscription being installed.
    flush();

    const unsubscribe = useSessionStore.subscribe((state, previous) => {
      if (state.snapshot === previous.snapshot || timer) return;
      const elapsed = Date.now() - lastFlushedAt;
      if (elapsed >= intervalMs) {
        flush();
        return;
      }
      timer = setTimeout(flush, intervalMs - elapsed);
    });

    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs]);

  return snapshot;
}
