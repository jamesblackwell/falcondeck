import { expandSyncIndex, mergeSyncExtensions, mergeSyncThreadPage, type DaemonSnapshot, type ExtensionSnapshot, type SyncIndex, type SyncThreadPage, type ThreadSortMode } from '@falcondeck/client-core'
import { persistSessionCacheNow, useRelayStore, useSessionStore } from '@/store'
import { logConnection } from '@/store/connection-log-store'

type Rpc = ReturnType<typeof useRelayStore.getState>['_callRpc']

export async function requestInitialSync(relay: { _callRpc: Rpc }, selected: string | null, legacy: () => Promise<DaemonSnapshot>): Promise<DaemonSnapshot> {
  try {
    return expandSyncIndex(await relay._callRpc<SyncIndex>('sync.index', { selected_thread_id: selected }, { requestIdPrefix: 'mobile-index' }))
  } catch (error) {
    // Compatibility fallback only. A timeout must not start an even larger fetch.
    if ((error as { failure?: string })?.failure === 'method_unavailable' ||
        (error instanceof Error && /unsupported.*sync\.index|not registered/i.test(error.message))) return legacy()
    throw error
  }
}

interface SyncRequestScope {
  token: string
  socket: WebSocket | null
  sessionId: string | null
}

function requestScope(token: string): SyncRequestScope {
  const relay = useRelayStore.getState()
  return { token, socket: relay._getSocket(), sessionId: relay.sessionId }
}

function isCurrent(scope: SyncRequestScope) {
  const relay = useRelayStore.getState()
  return useSessionStore.getState().snapshot?.sync_index?.token === scope.token &&
    relay._getSocket() === scope.socket && relay.sessionId === scope.sessionId
}

const inFlight = new Map<string, { scope: SyncRequestScope; promise: Promise<void> }>()
function once(key: string, scope: SyncRequestScope, run: () => Promise<void>) {
  const existing = inFlight.get(key)
  if (existing && existing.scope.socket === scope.socket && existing.scope.sessionId === scope.sessionId) return existing.promise
  const promise = run().finally(() => {
    // Canceled work from the previous socket must not evict its replacement.
    if (inFlight.get(key)?.promise === promise) inFlight.delete(key)
  })
  inFlight.set(key, { scope, promise })
  return promise
}

export function loadSyncThreadPage(workspaceId: string, sort: ThreadSortMode = 'last_updated', limit = 10) {
  const index = useSessionStore.getState().snapshot?.sync_index
  if (!index) return Promise.resolve()
  const cursor = index.cursors[`${workspaceId}:${sort}`]
  if (cursor === null) return Promise.resolve()
  const scope = requestScope(index.token)
  return once(`${index.token}:${workspaceId}:${sort}`, scope, async () => {
    try {
      const page = await useRelayStore.getState()._callRpc<SyncThreadPage>('sync.threads', { token: index.token, workspace_id: workspaceId, cursor: cursor ?? 0, sort, limit }, { requestIdPrefix: 'mobile-index-page' })
      if (!isCurrent(scope)) return
      useSessionStore.setState(state => state.snapshot ? { snapshot: mergeSyncThreadPage(state.snapshot, page, sort) } : state)
      persistSessionCacheNow()
    } catch (error) {
      if (!isCurrent(scope)) return
      if (error instanceof Error && error.message.includes('sync_index_expired')) {
        // Route recovery through the existing snapshot/event race coordinator.
        useRelayStore.setState({ hasSyncedOnce: false })
      }
      logConnection('warn', 'Could not load more threads', error instanceof Error ? error.message : String(error))
    }
  })
}

export function loadSyncExtensions(token: string) {
  const index = useSessionStore.getState().snapshot?.sync_index
  if (!index || index.token !== token || index.extensions_loaded) return Promise.resolve()
  const scope = requestScope(token)
  return once(`${token}:extensions`, scope, async () => {
    if (!isCurrent(scope)) return
    let extensions: ExtensionSnapshot
    try {
      extensions = await useRelayStore.getState()._callRpc<ExtensionSnapshot>('sync.extensions', { token }, { requestIdPrefix: 'mobile-index-extensions' })
    } catch (error) {
      if (!isCurrent(scope)) return
      if (error instanceof Error && error.message.includes('sync_index_expired')) {
        useRelayStore.setState({ hasSyncedOnce: false })
        return
      }
      throw error
    }
    if (!isCurrent(scope)) return
    useSessionStore.setState(state => state.snapshot ? { snapshot: mergeSyncExtensions(state.snapshot, token, extensions) } : state)
    persistSessionCacheNow()
  })
}
