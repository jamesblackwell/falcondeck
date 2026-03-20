/**
 * Session store — daemon snapshot, threads, conversation items.
 *
 * Consumes decrypted daemon events from the relay connection and
 * maintains the same state shape as the desktop/remote-web apps.
 */
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import {
  applySnapshotEvent,
  buildProjectGroups,
  reconcileSnapshotSelection,
  upsertConversationItem,
  type ConversationItem,
  type DaemonSnapshot,
  type EventEnvelope,
  type ThreadDetail,
} from '@falcondeck/client-core'

interface SessionState {
  snapshot: DaemonSnapshot | null
  selectedWorkspaceId: string | null
  selectedThreadId: string | null
  threadItems: Record<string, ConversationItem[]>
  threadDetail: ThreadDetail | null
}

interface SessionActions {
  applyDaemonEvent: (event: EventEnvelope) => void
  selectThread: (workspaceId: string, threadId: string) => void
  selectWorkspace: (workspaceId: string) => void
  selectNewThread: (workspaceId: string) => void
  setThreadDetail: (detail: ThreadDetail | null) => void
  reconcileSelection: () => void
  reset: () => void
}

type SessionStore = SessionState & SessionActions

const initialState: SessionState = {
  snapshot: null,
  selectedWorkspaceId: null,
  selectedThreadId: null,
  threadItems: {},
  threadDetail: null,
}

const EMPTY_ITEMS: ConversationItem[] = []
const EMPTY_APPROVALS: DaemonSnapshot['interactive_requests'] = []

export const useSessionStore = create<SessionStore>((set, get) => ({
  ...initialState,

  applyDaemonEvent: (event) => {
    set((state) => {
      // Apply snapshot-level event
      let nextSnapshot = applySnapshotEvent(state.snapshot, event)
      /* v8 ignore next 3 — defensive fallback, applySnapshotEvent handles this */
      if (!nextSnapshot && event.event.type === 'snapshot') {
        nextSnapshot = event.event.snapshot
      }

      // Apply conversation item events
      let nextThreadItems = state.threadItems
      let nextThreadDetail = state.threadDetail
      const de = event.event

      if (
        event.thread_id &&
        (de.type === 'conversation-item-added' || de.type === 'conversation-item-updated')
      ) {
        const threadId = event.thread_id
        const bucket = nextThreadItems[threadId] ?? []
        nextThreadItems = {
          ...nextThreadItems,
          [threadId]: upsertConversationItem(bucket, de.item),
        }

        if (nextThreadDetail?.thread.id === threadId) {
          nextThreadDetail = {
            ...nextThreadDetail,
            items: upsertConversationItem(nextThreadDetail.items, de.item),
          }
        }
      }

      // Reconcile selection
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
        threadDetail: reconciledThreadDetail,
        selectedWorkspaceId: nextSelection.workspaceId,
        selectedThreadId: nextSelection.threadId,
      }
    })
  },

  selectThread: (workspaceId, threadId) =>
    set((state) => ({
      selectedWorkspaceId: workspaceId,
      selectedThreadId: threadId,
      threadDetail: state.threadDetail?.thread.id === threadId ? state.threadDetail : null,
    })),

  selectWorkspace: (workspaceId) => {
    const { snapshot } = get()
    const workspace = snapshot?.workspaces.find((w) => w.id === workspaceId)
    const threadId = workspace?.current_thread_id ?? null
    set((state) => ({
      selectedWorkspaceId: workspaceId,
      selectedThreadId: threadId,
      threadDetail: state.threadDetail?.thread.id === threadId ? state.threadDetail : null,
    }))
  },

  selectNewThread: (workspaceId) =>
    set({
      selectedWorkspaceId: workspaceId,
      selectedThreadId: null,
      threadDetail: null,
    }),

  setThreadDetail: (detail) => {
    if (!detail) {
      set({ threadDetail: null })
      return
    }
    set((state) => {
      const threadId = detail.thread.id
      const existing = state.threadItems[threadId] ?? []
      const merged = detail.items.reduce(
        (items, item) => upsertConversationItem(items, item),
        existing,
      )
      const isSelectedThread = state.selectedThreadId === threadId
      return {
        threadDetail: isSelectedThread ? detail : state.threadDetail,
        threadItems: { ...state.threadItems, [threadId]: merged },
      }
    })
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
  },

  reset: () => set(initialState),
}))

// ── Derived selectors (React hooks — tested via E2E, not unit tests) ──

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
