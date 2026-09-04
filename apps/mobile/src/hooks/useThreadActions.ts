import { useCallback } from 'react'

import { normalizeThreadSummary, type ThreadSummary } from '@falcondeck/client-core'

import { triggerThreadArchiveFailedHaptic } from '@/lib/haptics'
import { useRelayStore, useSessionStore } from '@/store'

/**
 * "Mark unread" and the auto-mark-read effect on the conversation screen pull
 * in opposite directions: the effect reads whatever thread is on screen, so
 * without this the unread state would be undone within its debounce window.
 * The state is module-scoped because the two live in different trees (the
 * sheet hangs off the sidebar, the effect off the conversation screen).
 */
let autoReadSuppression: { threadId: string; activitySeq: number } | null = null

function suppressAutoMarkRead(threadId: string, activitySeq: number) {
  autoReadSuppression = { threadId, activitySeq }
}

export function clearAutoMarkReadSuppression() {
  autoReadSuppression = null
}

/**
 * `suppress` — skip the auto-read. `released` — the suppression just expired
 * (different thread, or new agent activity the user has not seen), so the
 * caller should also drop its own dedupe state before reading again.
 */
export function consumeAutoReadSuppression(
  threadId: string,
  activitySeq: number,
): 'suppress' | 'released' | 'none' {
  const current = autoReadSuppression
  if (!current) return 'none'
  if (current.threadId !== threadId || current.activitySeq !== activitySeq) {
    autoReadSuppression = null
    return 'released'
  }
  return 'suppress'
}

export function useThreadActions() {
  const archiveThread = useCallback(async (workspaceId: string, threadId: string) => {
    const session = useSessionStore.getState()
    const undo = session.archiveThreadLocally(threadId)
    if (!undo) return
    const relay = useRelayStore.getState()
    try {
      await relay._callRpc(
        'thread.archive',
        { workspace_id: workspaceId, thread_id: threadId },
        { requestIdPrefix: 'mobile-thread' },
      )
      relay._setError(null)
    } catch (e) {
      session.restoreArchivedThread(undo)
      triggerThreadArchiveFailedHaptic()
      relay._setError(e instanceof Error ? e.message : 'Failed to archive thread')
      throw e
    }
  }, [])

  const unarchiveThread = useCallback(async (workspaceId: string, threadId: string) => {
    const relay = useRelayStore.getState()
    try {
      const thread = normalizeThreadSummary(
        await relay._callRpc<ThreadSummary>(
          'thread.unarchive',
          { workspace_id: workspaceId, thread_id: threadId },
          { requestIdPrefix: 'mobile-thread' },
        ),
      )
      useSessionStore.getState().applyThreadSummary(thread)
      relay._setError(null)
    } catch (e) {
      relay._setError(e instanceof Error ? e.message : 'Failed to unarchive thread')
      throw e
    }
  }, [])

  const renameThread = useCallback(async (workspaceId: string, threadId: string, title: string) => {
    const relay = useRelayStore.getState()
    try {
      await relay._callRpc(
        'thread.update',
        { workspace_id: workspaceId, thread_id: threadId, title },
        { requestIdPrefix: 'mobile-thread' },
      )
      relay._setError(null)
    } catch (e) {
      relay._setError(e instanceof Error ? e.message : 'Failed to rename thread')
      throw e
    }
  }, [])

  const suggestThreadTitle = useCallback(
    async (workspaceId: string, threadId: string) => {
      const relay = useRelayStore.getState()
      try {
        const result = (await relay._callRpc(
          'thread.suggestTitle',
          { workspace_id: workspaceId, thread_id: threadId },
          { requestIdPrefix: 'mobile-thread' },
        )) as { title?: unknown }
        const title = typeof result?.title === 'string' ? result.title.trim() : ''
        if (!title) throw new Error("Couldn't generate a title")
        relay._setError(null)
        return title
      } catch (e) {
        relay._setError(
          e instanceof Error ? e.message : "Couldn't generate a title",
        )
        throw e
      }
    },
    [],
  )

  const setThreadPinned = useCallback(
    async (workspaceId: string, threadId: string, pinned: boolean) => {
      const relay = useRelayStore.getState()
      try {
        await relay._callRpc(
          'thread.update',
          { workspace_id: workspaceId, thread_id: threadId, pinned },
          { requestIdPrefix: 'mobile-thread' },
        )
        relay._setError(null)
      } catch (e) {
        relay._setError(e instanceof Error ? e.message : 'Failed to update pin')
        throw e
      }
    },
    [],
  )

  const setThreadPinnedInProject = useCallback(
    async (workspaceId: string, threadId: string, pinnedInProject: boolean) => {
      const relay = useRelayStore.getState()
      try {
        await relay._callRpc(
          'thread.update',
          {
            workspace_id: workspaceId,
            thread_id: threadId,
            pinned_in_project: pinnedInProject,
          },
          { requestIdPrefix: 'mobile-thread' },
        )
        relay._setError(null)
      } catch (e) {
        relay._setError(e instanceof Error ? e.message : 'Failed to update pin')
        throw e
      }
    },
    [],
  )

  const markThreadRead = useCallback(
    async (workspaceId: string, threadId: string, readSeq: number) => {
      const relay = useRelayStore.getState()
      const thread = normalizeThreadSummary(
        await relay._callRpc<ThreadSummary>(
          'thread.mark_read',
          { workspace_id: workspaceId, thread_id: threadId, read_seq: readSeq },
          { requestIdPrefix: 'mobile-thread' },
        ),
      )
      useSessionStore.getState().applyThreadSummary(thread)
      return thread
    },
    [],
  )

  const markThreadUnread = useCallback(
    async (workspaceId: string, threadId: string, activitySeq: number) => {
      const relay = useRelayStore.getState()
      suppressAutoMarkRead(threadId, activitySeq)
      try {
        const thread = normalizeThreadSummary(
          await relay._callRpc<ThreadSummary>(
            'thread.mark_unread',
            { workspace_id: workspaceId, thread_id: threadId },
            { requestIdPrefix: 'mobile-thread' },
          ),
        )
        // Re-pin the suppression to the seq the daemon actually settled on, so
        // activity that arrived mid-flight still releases it.
        suppressAutoMarkRead(threadId, thread.attention.last_agent_activity_seq)
        useSessionStore.getState().applyThreadSummary(thread)
        relay._setError(null)
      } catch (e) {
        clearAutoMarkReadSuppression()
        relay._setError(
          e instanceof Error ? e.message : 'Failed to mark thread as unread',
        )
        throw e
      }
    },
    [],
  )

  // These fields are explicit-optional on the wire: omitting the key leaves
  // the thread unchanged, sending null clears the override. Always sending
  // the key is what makes "back to default" work.
  const setThreadMode = useCallback(
    async (
      workspaceId: string,
      threadId: string,
      field: 'permission_mode' | 'sandbox_mode' | 'service_tier',
      mode: string | null,
    ) => {
      const relay = useRelayStore.getState()
      try {
        await relay._callRpc(
          'thread.update',
          { workspace_id: workspaceId, thread_id: threadId, [field]: mode },
          { requestIdPrefix: 'mobile-thread' },
        )
        relay._setError(null)
      } catch (e) {
        relay._setError(
          e instanceof Error
            ? e.message
            : field === 'permission_mode'
              ? 'Failed to update permission mode'
              : field === 'service_tier'
                ? 'Failed to update speed'
                : 'Failed to update sandbox mode',
        )
        throw e
      }
    },
    [],
  )

  // Omitting `objective` is how a status-only update keeps the objective the
  // thread already has; sending it empty would clear the goal instead.
  const setThreadGoal = useCallback(
    async (
      workspaceId: string,
      threadId: string,
      payload: { objective?: string; token_budget?: number | null; status?: string },
    ) => {
      const relay = useRelayStore.getState()
      try {
        await relay._callRpc(
          'thread.goal.set',
          { workspace_id: workspaceId, thread_id: threadId, ...payload },
          { requestIdPrefix: 'mobile-goal' },
        )
        relay._setError(null)
      } catch (e) {
        relay._setError(e instanceof Error ? e.message : 'Failed to set goal')
        throw e
      }
    },
    [],
  )

  const clearThreadGoal = useCallback(async (workspaceId: string, threadId: string) => {
    const relay = useRelayStore.getState()
    try {
      await relay._callRpc(
        'thread.goal.clear',
        { workspace_id: workspaceId, thread_id: threadId },
        { requestIdPrefix: 'mobile-goal' },
      )
      relay._setError(null)
    } catch (e) {
      relay._setError(e instanceof Error ? e.message : 'Failed to clear goal')
      throw e
    }
  }, [])

  // Queue mutations need no local reconciliation: the daemon emits a
  // thread-updated event carrying the fresh summary, which the session store
  // already applies. Failures deliberately leave the chip in place — a failed
  // steer keeps the message queued daemon-side.
  const removeQueuedTurn = useCallback(
    async (workspaceId: string, threadId: string, queuedId: string) => {
      const relay = useRelayStore.getState()
      try {
        await relay._callRpc(
          'thread.queue.remove',
          { workspace_id: workspaceId, thread_id: threadId, queued_id: queuedId },
          { requestIdPrefix: 'mobile-queue' },
        )
        relay._setError(null)
      } catch (e) {
        relay._setError(e instanceof Error ? e.message : 'Failed to remove queued message')
        throw e
      }
    },
    [],
  )

  const steerQueuedTurn = useCallback(
    async (workspaceId: string, threadId: string, queuedId: string) => {
      const relay = useRelayStore.getState()
      try {
        await relay._callRpc(
          'thread.queue.steer',
          { workspace_id: workspaceId, thread_id: threadId, queued_id: queuedId },
          { requestIdPrefix: 'mobile-queue' },
        )
        relay._setError(null)
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Failed to steer queued message'
        // Grok's interject returns before the thread-updated event reaches
        // the phone, so a second Steer tap (or a stale chip) used to banner
        // the daemon's "queued turn not found". Treat that as already gone.
        if (/queued turn not found/i.test(message)) {
          relay._setError(null)
          return
        }
        relay._setError(message)
        throw e
      }
    },
    [],
  )

  const editQueuedTurn = useCallback(
    async (workspaceId: string, threadId: string, queuedId: string, text: string) => {
      const relay = useRelayStore.getState()
      try {
        await relay._callRpc(
          'thread.queue.edit',
          { workspace_id: workspaceId, thread_id: threadId, queued_id: queuedId, text },
          { requestIdPrefix: 'mobile-queue' },
        )
        relay._setError(null)
      } catch (e) {
        relay._setError(e instanceof Error ? e.message : 'Failed to edit queued message')
        throw e
      }
    },
    [],
  )

  // Read-only, so a failure stays silent: the chip just shows no thumbnail
  // rather than raising a relay banner over a cosmetic miss.
  const queuedTurnAttachmentPreview = useCallback(
    async (workspaceId: string, threadId: string, queuedId: string) => {
      const relay = useRelayStore.getState()
      const result = (await relay._callRpc(
        'thread.queue.attachment_preview',
        { workspace_id: workspaceId, thread_id: threadId, queued_id: queuedId },
        { requestIdPrefix: 'mobile-queue' },
      )) as { url?: unknown } | null
      const url = result?.url
      return typeof url === 'string' && url.startsWith('data:image/') ? url : null
    },
    [],
  )

  return {
    archiveThread,
    unarchiveThread,
    renameThread,
    suggestThreadTitle,
    setThreadPinned,
    setThreadPinnedInProject,
    markThreadRead,
    markThreadUnread,
    setThreadMode,
    setThreadGoal,
    clearThreadGoal,
    removeQueuedTurn,
    steerQueuedTurn,
    editQueuedTurn,
    queuedTurnAttachmentPreview,
  }
}
