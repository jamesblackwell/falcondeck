import { useCallback } from 'react'

import { useRelayStore, useSessionStore } from '@/store'

export function useInterruptTurn() {
  return useCallback(async () => {
    const relay = useRelayStore.getState()
    const session = useSessionStore.getState()

    const workspaceId = session.selectedWorkspaceId
    const threadId = session.selectedThreadId
    if (!workspaceId || !threadId) return

    try {
      await relay._callRpc(
        'turn.interrupt',
        { workspace_id: workspaceId, thread_id: threadId },
        { requestIdPrefix: 'mobile-interrupt' },
      )
      relay._setError(null)
    } catch (e) {
      relay._setError(e instanceof Error ? e.message : 'Failed to interrupt turn')
    }
  }, [])
}
