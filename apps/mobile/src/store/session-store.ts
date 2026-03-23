/**
 * Session store — daemon snapshot, threads, conversation items.
 *
 * Consumes decrypted daemon events from the relay connection and
 * maintains the same state shape as the desktop/remote-web apps,
 * plus a mobile-only cache of recent thread history windows.
 */
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import {
  MOBILE_SESSION_CACHE_VERSION,
  applySnapshotEvent,
  buildProjectGroups,
  normalizeDaemonSnapshot,
  reconcileSnapshotSelection,
  upsertConversationItem,
  type CachedThreadHistory,
  type ConversationItem,
  type DaemonSnapshot,
  type EventEnvelope,
  type MobileSessionCache,
  type ThreadDetail,
} from '@falcondeck/client-core'

import { clearMobileSessionCache, persistMobileSessionCache } from '@/storage/mobile-session-cache'

const MAX_CACHED_THREADS = 5
const MAX_CACHED_ITEMS = 150

type ThreadDetailMergeMode = 'refresh' | 'prepend'

export interface ThreadHistoryState {
  hasOlder: boolean
  oldestItemId: string | null
  newestItemId: string | null
  isPartial: boolean
}

interface SessionState {
  snapshot: DaemonSnapshot | null
  selectedWorkspaceId: string | null
  selectedThreadId: string | null
  threadItems: Record<string, ConversationItem[]>
  threadHistory: Record<string, ThreadHistoryState>
  threadDetail: ThreadDetail | null
}

interface SessionActions {
  applyDaemonEvent: (event: EventEnvelope) => void
  applyDaemonEvents: (events: EventEnvelope[]) => void
  hydrateCache: (cache: MobileSessionCache) => void
  exportCache: () => MobileSessionCache | null
  selectThread: (workspaceId: string, threadId: string) => void
  selectWorkspace: (workspaceId: string) => void
  selectNewThread: (workspaceId: string) => void
  setThreadDetail: (
    detail: ThreadDetail | null,
    options?: { mergeMode?: ThreadDetailMergeMode },
  ) => void
  reconcileSelection: () => void
  reset: () => void
}

type SessionStore = SessionState & SessionActions

const initialState: SessionState = {
  snapshot: null,
  selectedWorkspaceId: null,
  selectedThreadId: null,
  threadItems: {},
  threadHistory: {},
  threadDetail: null,
}

const EMPTY_ITEMS: ConversationItem[] = []
const EMPTY_HISTORY: ThreadHistoryState = {
  hasOlder: false,
  oldestItemId: null,
  newestItemId: null,
  isPartial: false,
}

function conversationItemKey(item: ConversationItem) {
  return `${item.kind}:${item.id}`
}

function filterActiveSnapshot(snapshot: DaemonSnapshot | null): DaemonSnapshot | null {
  if (!snapshot) return null

  const threads = snapshot.threads.filter((thread) => !thread.is_archived)
  const visibleThreadIds = new Set(threads.map((thread) => thread.id))

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
    interactive_requests: snapshot.interactive_requests.filter((request) =>
      !request.thread_id || visibleThreadIds.has(request.thread_id)
    ),
  }
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
  }
}

function pruneThreadRecord<T>(
  record: Record<string, T>,
  visibleThreadIds: Set<string>,
): Record<string, T> {
  const entries = Object.entries(record).filter(([threadId]) => visibleThreadIds.has(threadId))
  return entries.length === Object.keys(record).length ? record : Object.fromEntries(entries)
}

function reconcileThreadDetail(
  detail: ThreadDetail | null,
  mergedItems: ConversationItem[],
  history: ThreadHistoryState,
): ThreadDetail | null {
  if (!detail) return null
  return {
    ...detail,
    items: mergedItems,
    has_older: history.hasOlder,
    oldest_item_id: history.oldestItemId,
    newest_item_id: history.newestItemId,
    is_partial: history.isPartial,
  }
}

function mergeHistoryState(
  existing: ThreadHistoryState | undefined,
  detail: ThreadDetail,
  mergedItems: ConversationItem[],
  mergeMode: ThreadDetailMergeMode,
): ThreadHistoryState {
  if (mergeMode === 'prepend') {
    return historyStateForItems(mergedItems, {
      hasOlder: detail.has_older,
      isPartial: detail.is_partial,
      oldestItemId: detail.oldest_item_id,
      newestItemId: mergedItems.at(-1)?.id ?? detail.newest_item_id ?? null,
    })
  }

  const preservesOlderWindow =
    !!detail.oldest_item_id && mergedItems[0]?.id !== detail.oldest_item_id

  return historyStateForItems(mergedItems, {
    hasOlder: preservesOlderWindow ? existing?.hasOlder ?? false : detail.has_older,
    isPartial: preservesOlderWindow ? existing?.isPartial ?? false : detail.is_partial,
    oldestItemId: mergedItems[0]?.id ?? detail.oldest_item_id ?? null,
    newestItemId: mergedItems.at(-1)?.id ?? detail.newest_item_id ?? null,
  })
}

function mergeThreadItems(
  existingItems: ConversationItem[],
  nextItems: ConversationItem[],
  mergeMode: ThreadDetailMergeMode,
): ConversationItem[] {
  if (mergeMode === 'prepend') {
    const nextKeys = new Set(nextItems.map(conversationItemKey))
    return [
      ...nextItems,
      ...existingItems.filter((item) => !nextKeys.has(conversationItemKey(item))),
    ]
  }

  return nextItems.reduce(
    (items, item) => upsertConversationItem(items, item),
    existingItems,
  )
}

function buildCacheFromState(state: SessionState): MobileSessionCache | null {
  const snapshot = filterActiveSnapshot(state.snapshot)
  if (!snapshot) return null

  const visibleThreadIds = new Set(snapshot.threads.map((thread) => thread.id))
  const orderedThreadIds = [
    state.selectedThreadId,
    ...snapshot.threads.map((thread) => thread.id),
  ].filter((threadId): threadId is string => !!threadId && visibleThreadIds.has(threadId))
  const recentThreadIds = [...new Set(orderedThreadIds)].slice(0, MAX_CACHED_THREADS)

  const threadHistories = Object.fromEntries(
    recentThreadIds.flatMap((threadId) => {
      const items = state.threadItems[threadId] ?? []
      if (items.length === 0) return []

      const cachedItems =
        items.length > MAX_CACHED_ITEMS ? items.slice(items.length - MAX_CACHED_ITEMS) : items
      const existingHistory = state.threadHistory[threadId] ?? EMPTY_HISTORY
      const hasOlder = existingHistory.hasOlder || cachedItems.length < items.length
      const isPartial = existingHistory.isPartial || cachedItems.length < items.length

      return [[
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
      ] as const]
    }),
  )

  return {
    version: MOBILE_SESSION_CACHE_VERSION,
    snapshot,
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedThreadId: state.selectedThreadId,
    recentThreadIds,
    threadHistories,
  }
}

function persistStateCache(state: SessionState) {
  persistMobileSessionCache(buildCacheFromState(state))
}

function applyEventsToState(state: SessionState, events: EventEnvelope[]): SessionState {
  if (events.length === 0) return state

  let nextSnapshot = state.snapshot
  let nextThreadItems = state.threadItems
  let nextThreadHistory = state.threadHistory
  let nextThreadDetail = state.threadDetail

  for (const event of events) {
    let candidateSnapshot = applySnapshotEvent(nextSnapshot, event)
    if (!candidateSnapshot && event.event.type === 'snapshot') {
      candidateSnapshot = normalizeDaemonSnapshot(event.event.snapshot)
    }
    if (candidateSnapshot) {
      nextSnapshot = filterActiveSnapshot(candidateSnapshot)
    }

    const daemonEvent = event.event
    if (
      event.thread_id &&
      (daemonEvent.type === 'conversation-item-added' || daemonEvent.type === 'conversation-item-updated')
    ) {
      const threadId = event.thread_id
      const existingItems = nextThreadItems[threadId] ?? EMPTY_ITEMS
      const mergedItems = upsertConversationItem(existingItems, daemonEvent.item)
      const existingHistory = nextThreadHistory[threadId] ?? EMPTY_HISTORY
      const nextHistory = historyStateForItems(mergedItems, existingHistory)

      nextThreadItems = { ...nextThreadItems, [threadId]: mergedItems }
      nextThreadHistory = { ...nextThreadHistory, [threadId]: nextHistory }

      if (nextThreadDetail?.thread.id === threadId) {
        nextThreadDetail = reconcileThreadDetail(nextThreadDetail, mergedItems, nextHistory)
      }
    }
  }

  if (nextSnapshot) {
    const visibleThreadIds = new Set(nextSnapshot.threads.map((thread) => thread.id))
    nextThreadItems = pruneThreadRecord(nextThreadItems, visibleThreadIds)
    nextThreadHistory = pruneThreadRecord(nextThreadHistory, visibleThreadIds)
    if (nextThreadDetail && !visibleThreadIds.has(nextThreadDetail.thread.id)) {
      nextThreadDetail = null
    }
  }

  const nextSelection = reconcileSnapshotSelection(
    nextSnapshot ?? state.snapshot,
    state.selectedWorkspaceId,
    state.selectedThreadId,
  )
  const reconciledThreadDetail =
    nextThreadDetail?.thread.id === nextSelection.threadId ? nextThreadDetail : null

  return {
    snapshot: nextSnapshot ?? state.snapshot,
    threadItems: nextThreadItems,
    threadHistory: nextThreadHistory,
    threadDetail: reconciledThreadDetail,
    selectedWorkspaceId: nextSelection.workspaceId,
    selectedThreadId: nextSelection.threadId,
  }
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  ...initialState,

  applyDaemonEvent: (event) => {
    set((state) => applyEventsToState(state, [event]))
    persistStateCache(get())
  },

  applyDaemonEvents: (events) => {
    if (events.length === 0) return
    set((state) => applyEventsToState(state, events))
    persistStateCache(get())
  },

  hydrateCache: (cache) => {
    const snapshot = filterActiveSnapshot(normalizeDaemonSnapshot(cache.snapshot))
    const visibleThreadIds = new Set(snapshot?.threads.map((thread) => thread.id) ?? [])
    const cachedThreadHistories = Object.entries(cache.threadHistories ?? {}).filter(([threadId]) =>
      visibleThreadIds.has(threadId),
    )
    const threadItems = Object.fromEntries(
      cachedThreadHistories.map(([threadId, history]) => [
        threadId,
        history.items,
      ]),
    )
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
    )
    const nextSelection = reconcileSnapshotSelection(
      snapshot,
      cache.selectedWorkspaceId,
      cache.selectedThreadId,
    )

    set({
      snapshot,
      selectedWorkspaceId: nextSelection.workspaceId,
      selectedThreadId: nextSelection.threadId,
      threadItems,
      threadHistory,
      threadDetail: null,
    })
    persistStateCache(get())
  },

  exportCache: () => buildCacheFromState(get()),

  selectThread: (workspaceId, threadId) => {
    set((state) => ({
      selectedWorkspaceId: workspaceId,
      selectedThreadId: threadId,
      threadDetail: state.threadDetail?.thread.id === threadId ? state.threadDetail : null,
    }))
    persistStateCache(get())
  },

  selectWorkspace: (workspaceId) => {
    const { snapshot } = get()
    const workspace = snapshot?.workspaces.find((entry) => entry.id === workspaceId)
    const threadId = workspace?.current_thread_id ?? null
    set((state) => ({
      selectedWorkspaceId: workspaceId,
      selectedThreadId: threadId,
      threadDetail: state.threadDetail?.thread.id === threadId ? state.threadDetail : null,
    }))
    persistStateCache(get())
  },

  selectNewThread: (workspaceId) => {
    set({
      selectedWorkspaceId: workspaceId,
      selectedThreadId: null,
      threadDetail: null,
    })
    persistStateCache(get())
  },

  setThreadDetail: (detail, options) => {
    if (!detail) {
      set({ threadDetail: null })
      persistStateCache(get())
      return
    }

    set((state) => {
      const threadId = detail.thread.id
      const existingItems = state.threadItems[threadId] ?? EMPTY_ITEMS
      const mergeMode = options?.mergeMode ?? 'refresh'
      const mergedItems = mergeThreadItems(
        existingItems,
        detail.items,
        mergeMode,
      )
      const nextHistory = mergeHistoryState(
        state.threadHistory[threadId],
        detail,
        mergedItems,
        mergeMode,
      )
      const mergedDetail = reconcileThreadDetail(detail, mergedItems, nextHistory)
      const isSelectedThread = state.selectedThreadId === threadId

      return {
        threadDetail: isSelectedThread ? mergedDetail : state.threadDetail,
        threadItems: { ...state.threadItems, [threadId]: mergedItems },
        threadHistory: { ...state.threadHistory, [threadId]: nextHistory },
      }
    })
    persistStateCache(get())
  },

  reconcileSelection: () => {
    set((state) => {
      const next = reconcileSnapshotSelection(
        state.snapshot,
        state.selectedWorkspaceId,
        state.selectedThreadId,
      )
      return {
        selectedWorkspaceId: next.workspaceId,
        selectedThreadId: next.threadId,
        threadDetail: state.threadDetail?.thread.id === next.threadId ? state.threadDetail : null,
      }
    })
    persistStateCache(get())
  },

  reset: () => {
    set(initialState)
    clearMobileSessionCache()
  },
}))

/* v8 ignore start */
export function useGroups() {
  return useSessionStore((s) =>
    buildProjectGroups(s.snapshot?.workspaces ?? [], s.snapshot?.threads ?? []),
  )
}

export function useSelectedWorkspace() {
  return useSessionStore((s) =>
    s.snapshot?.workspaces.find((w) => w.id === s.selectedWorkspaceId) ?? null,
  )
}

export function useSelectedThread() {
  return useSessionStore((s) =>
    s.snapshot?.threads.find((t) => t.id === s.selectedThreadId) ?? null,
  )
}

export function useSelectedThreadHistory() {
  return useSessionStore((s) => {
    if (!s.selectedThreadId) return EMPTY_HISTORY
    return s.threadHistory[s.selectedThreadId] ?? EMPTY_HISTORY
  })
}

export function useConversationItems() {
  return useSessionStore(useShallow((s) => {
    if (s.threadDetail) return s.threadDetail.items
    if (s.selectedThreadId) return s.threadItems[s.selectedThreadId] ?? EMPTY_ITEMS
    return EMPTY_ITEMS
  }))
}

export function useApprovals() {
  return useSessionStore(useShallow((s) =>
    (s.snapshot?.interactive_requests ?? []).filter(
      (a) => !s.selectedThreadId || a.thread_id === s.selectedThreadId,
    ),
  ))
}
/* v8 ignore stop */
