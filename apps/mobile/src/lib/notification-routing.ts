import { normalizeThreadHandle, type SessionCryptoState, type ThreadHandle } from '@falcondeck/client-core'

import { useRelayStore } from '@/store/relay-store'
import { useSessionStore } from '@/store/session-store'
import {
  handleNotificationTapData,
  notificationDestinationFromData,
  type PushNotificationData,
} from './push-notifications'

type RelayScope = {
  sessionId: string | null
  socket: WebSocket | null
  crypto: SessionCryptoState | null
}

type PendingDestination = {
  data: PushNotificationData
  sessionId: string | null
  resolve: (selected: boolean) => void
  requestScope: RelayScope | null
  retryTimer: ReturnType<typeof setTimeout> | null
}

/** Notification targets can be absent from both the offline cache and a
 * compact sync index. Keep the tap until the daemon can resolve it directly. */
export function createNotificationRouter() {
  let pending: PendingDestination | null = null

  function finish(selected: boolean) {
    const destination = pending
    pending = null
    if (destination?.retryTimer) clearTimeout(destination.retryTimer)
    destination?.resolve(selected)
  }

  function trySelect() {
    const destination = pending
    if (!destination) return
    const relay = useRelayStore.getState()
    if (relay.sessionId !== destination.sessionId || !notificationDestinationFromData(destination.data)) {
      finish(false)
      return
    }
    const session = useSessionStore.getState()
    if (!session.snapshot) return
    const { workspaceId, threadId } = destination.data
    const owner = session.snapshot.threads.find(thread => thread.id === threadId)
    if (owner && (owner.is_archived || (workspaceId && owner.workspace_id !== workspaceId))) {
      finish(false)
      return
    }
    if (owner || (!threadId && session.snapshot.workspaces.some(workspace => workspace.id === workspaceId))) {
      pending = null
      if (destination.retryTimer) clearTimeout(destination.retryTimer)
      destination.resolve(handleNotificationTapData(destination.data))
      return
    }
    if (!relay.hasSyncedOnce || !relay.isEncrypted || !relay.machinePresence?.daemon_connected ||
        relay.machinePresence.daemon_rpc_ready === false) return
    if (!workspaceId || !threadId || !session.snapshot.workspaces.some(workspace => workspace.id === workspaceId)) {
      finish(false)
      return
    }

    const scope: RelayScope = {
      sessionId: relay.sessionId,
      socket: relay._getSocket(),
      crypto: relay._getSessionCrypto(),
    }
    if (destination.retryTimer || (destination.requestScope?.socket === scope.socket &&
        destination.requestScope.crypto === scope.crypto)) return
    destination.requestScope = scope
    void relay._callRpc<ThreadHandle>('thread.detail', {
      workspace_id: workspaceId,
      thread_id: threadId,
      mode: 'tail',
      limit: 1,
      inline_images: false,
      tool_output_bytes: 0,
      strict_limit: true,
      compact_workspace: true,
    }, { requestIdPrefix: 'mobile-notification' }).then(raw => {
      const currentRelay = useRelayStore.getState()
      if (pending !== destination || currentRelay.sessionId !== scope.sessionId ||
          currentRelay._getSocket() !== scope.socket || currentRelay._getSessionCrypto() !== scope.crypto) return
      const handle = normalizeThreadHandle(raw)
      if (handle.workspace.id !== workspaceId || handle.thread.id !== threadId ||
          handle.thread.workspace_id !== workspaceId || handle.thread.is_archived) {
        finish(false)
        return
      }
      // A live event may have supplied a newer summary during the read.
      const currentSession = useSessionStore.getState()
      const workspace = currentSession.snapshot?.workspaces.find(workspace => workspace.id === workspaceId)
      if (!workspace) {
        finish(false)
        return
      }
      if (!currentSession.snapshot?.threads.some(thread => thread.id === threadId)) {
        // compact_workspace omits catalogs. Preserve the indexed workspace
        // and its current thread while inserting only the resolved summary.
        currentSession.applyThreadHandle({ workspace, thread: handle.thread })
      }
      trySelect()
    }).catch(error => {
      if (pending !== destination || destination.requestScope !== scope) return
      if (error instanceof Error && /(?:thread|workspace).*not found/i.test(error.message)) {
        finish(false)
        useRelayStore.getState()._setError('This conversation is no longer available.')
        return
      }
      // Keep the destination for the next connection; a temporary RPC failure
      // must not consume the tap or select the workspace's current thread.
      console.warn('Failed to resolve notification destination', error)
      destination.retryTimer = setTimeout(() => {
        destination.retryTimer = null
        destination.requestScope = null
        if (pending === destination) trySelect()
      }, 2000)
    })
  }

  const unsubscribeSession = useSessionStore.subscribe((state, previous) => {
    // A deliberate sidebar selection takes precedence over a waiting tap.
    if (pending && state.snapshot === previous.snapshot &&
        (state.selectedThreadId !== previous.selectedThreadId ||
         state.selectedWorkspaceId !== previous.selectedWorkspaceId)) {
      finish(false)
    }
    trySelect()
  })
  const unsubscribeRelay = useRelayStore.subscribe(trySelect)

  return {
    select(data: unknown): Promise<boolean> {
      finish(false)
      const destination = notificationDestinationFromData(data)
      if (!destination) return Promise.resolve(false)
      return new Promise(resolve => {
        pending = {
          data: destination,
          sessionId: useRelayStore.getState().sessionId,
          resolve,
          requestScope: null,
          retryTimer: null,
        }
        trySelect()
      })
    },
    dispose() {
      unsubscribeSession()
      unsubscribeRelay()
      finish(false)
    },
  }
}
