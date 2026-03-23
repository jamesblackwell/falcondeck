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

  return { archiveThread, renameThread }
}
