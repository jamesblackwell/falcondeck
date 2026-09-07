import { normalizeThreadDetail, type ThreadDetail } from '@falcondeck/client-core'
import { useRelayStore, useSessionStore } from '@/store'
import { logConnection } from '@/store/connection-log-store'
import { MOBILE_THREAD_DETAIL_OPTIONS, MOBILE_THREAD_DETAIL_TAIL_LIMIT } from './useSessionActions'
import { beginSelectedThreadDetailRead } from './selected-thread-detail-read'

/** Repairs the open transcript, which sync.index deliberately does not contain. */
export function createRelayTranscriptRecovery() {
  let revision = 0
  let readyRevision = 0
  let completedRevision = 0
  let pending: object | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let failures = 0

  const clearRetry = () => {
    if (retry !== null) clearTimeout(retry)
    retry = null
  }

  const repair = async () => {
    if (pending || retry !== null || readyRevision !== revision || completedRevision === revision) return
    const relay = useRelayStore.getState()
    const session = useSessionStore.getState()
    const { selectedWorkspaceId: workspaceId, selectedThreadId: threadId } = session
    if (!workspaceId || !threadId) {
      completedRevision = revision
      return
    }
    const socket = relay._getSocket()
    const crypto = relay._getSessionCrypto()
    if (!socket || !crypto || !relay.machinePresence?.daemon_connected ||
        relay.machinePresence.daemon_rpc_ready === false) return
    const request = {}
    pending = request
    const ownsTailRead = beginSelectedThreadDetailRead()
    const requestRevision = revision
    const sameConnection = () => {
      const current = useRelayStore.getState()
      return current.sessionId === relay.sessionId &&
        current._getSocket() === socket && current._getSessionCrypto() === crypto
    }
    const ownsConnection = () => pending === request && sameConnection()
    const ownsSelection = () => {
      const current = useSessionStore.getState()
      return current.selectedWorkspaceId === workspaceId && current.selectedThreadId === threadId
    }
    try {
      const detail = normalizeThreadDetail(await relay._callRpc<ThreadDetail>('thread.detail', {
        workspace_id: workspaceId, thread_id: threadId, mode: 'tail',
        limit: MOBILE_THREAD_DETAIL_TAIL_LIMIT, ...MOBILE_THREAD_DETAIL_OPTIONS,
      }, { requestIdPrefix: 'mobile-detail-recovery' }))
      if (!ownsConnection() || revision !== requestRevision) return
      completedRevision = requestRevision
      // Navigation owns the new thread's load; a late recovery must neither
      // replace it nor start another background request for it.
      if (!ownsSelection() || !ownsTailRead()) return
      useSessionStore.getState().setThreadDetail(detail, { mergeMode: 'refresh' })
      failures = 0
    } catch (error) {
      if (!ownsConnection() || revision !== requestRevision) return
      if (!ownsSelection() || !ownsTailRead()) {
        completedRevision = requestRevision
        return
      }
      failures += 1
      logConnection('warn', 'Could not repair conversation after replay loss',
        error instanceof Error ? error.message : String(error))
      if (failures < 3) {
        retry = setTimeout(() => {
          retry = null
          if (sameConnection() && ownsSelection() && ownsTailRead()) void repair()
          else completedRevision = requestRevision
        }, 1000 * failures)
      } else {
        completedRevision = requestRevision
        useSessionStore.getState().setThreadDetailError(threadId,
          "Couldn't sync this conversation. Check your connection and try again.")
      }
    } finally {
      if (pending === request) {
        pending = null
        // A newer invalidation arrived during this request. Only start its
        // replacement once the corresponding authoritative index has landed.
        if (revision !== requestRevision) void repair()
      }
    }
  }

  return {
    invalidate() {
      revision += 1
      failures = 0
      clearRetry()
    },
    snapshotApplied() {
      readyRevision = revision
      void repair()
    },
    cancel() {
      clearRetry()
      pending = null
      revision = 0
      readyRevision = 0
      completedRevision = 0
      failures = 0
    },
  }
}
