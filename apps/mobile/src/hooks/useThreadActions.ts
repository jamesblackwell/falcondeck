import { useCallback } from 'react'

import { useRelayStore } from '@/store'

export function useThreadActions() {
  const archiveThread = useCallback(async (workspaceId: string, threadId: string) => {
    const relay = useRelayStore.getState()
    try {
      await relay._callRpc(
        'thread.archive',
        { workspace_id: workspaceId, thread_id: threadId },
        { requestIdPrefix: 'mobile-thread' },
      )
      relay._setError(null)
    } catch (e) {
      relay._setError(e instanceof Error ? e.message : 'Failed to archive thread')
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

  // `permission_mode` / `sandbox_mode` are explicit-optional on the wire:
  // omitting the key leaves the thread unchanged, sending null clears the
  // override. Always sending the key is what makes "back to default" work.
  const setThreadMode = useCallback(
    async (
      workspaceId: string,
      threadId: string,
      field: 'permission_mode' | 'sandbox_mode',
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
        relay._setError(e instanceof Error ? e.message : 'Failed to steer queued message')
        throw e
      }
    },
    [],
  )

  return {
    archiveThread,
    renameThread,
    setThreadPinned,
    setThreadMode,
    setThreadGoal,
    clearThreadGoal,
    removeQueuedTurn,
    steerQueuedTurn,
  }
}
