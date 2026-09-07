import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { expandSyncIndex, type ExtensionSnapshot, type SyncThreadPage } from '@falcondeck/client-core'
import { useRelayStore, useSessionStore } from '@/store'
import { snapshot, thread } from '@/test/factories'
import { loadSyncExtensions, loadSyncThreadPage, requestInitialSync } from './sync-index'

const originalRpc = useRelayStore.getState()._callRpc
beforeEach(() => {
  useSessionStore.getState().reset()
  useRelayStore.setState({ hasSyncedOnce: true, sessionId: 'session-1' })
  useRelayStore.getState()._setSocket(null)
  useRelayStore.getState()._callRpc = originalRpc
})
afterEach(() => {
  useRelayStore.getState()._setSocket(null)
  useRelayStore.getState()._callRpc = originalRpc
})

function setIndex(token: string) {
  useSessionStore.setState({ snapshot: expandSyncIndex({ token, snapshot: snapshot({ threads: [] }), agent_catalogs: [], model_catalogs: [], workspace_agents: {}, workspace_models: {}, counts: {} }) })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

it('falls back only for an unavailable method, never for a timeout', async () => {
  const legacy = vi.fn().mockResolvedValue(snapshot())
  const unavailable = Object.assign(new Error('relay rpc method is unavailable'), { failure: 'method_unavailable' })
  const rpc = vi.fn().mockRejectedValue(unavailable) as unknown as typeof originalRpc
  await requestInitialSync({ _callRpc: rpc }, null, legacy)
  expect(legacy).toHaveBeenCalledOnce()
  legacy.mockClear()
  vi.mocked(rpc).mockRejectedValue(new Error('Timed out waiting for a response'))
  await expect(requestInitialSync({ _callRpc: rpc }, null, legacy)).rejects.toThrow('Timed out')
  expect(legacy).not.toHaveBeenCalled()
})

it('joins duplicate page loads and ignores a response from a replaced index', async () => {
  const initial = expandSyncIndex({ token: 'old', snapshot: snapshot({ threads: [] }), agent_catalogs: [], model_catalogs: [], workspace_agents: {}, workspace_models: {}, counts: {} })
  useSessionStore.setState({ snapshot: initial })
  let complete!: (value: unknown) => void
  const call = vi.fn().mockImplementation(() => new Promise(resolve => { complete = resolve }))
  useRelayStore.getState()._callRpc = call as typeof originalRpc
  const first = loadSyncThreadPage('workspace-1')
  const second = loadSyncThreadPage('workspace-1')
  expect(call).toHaveBeenCalledOnce()
  useSessionStore.setState({ snapshot: { ...initial, sync_index: { ...initial.sync_index!, token: 'new' } } })
  complete({ token: 'old', workspace_id: 'workspace-1', threads: [thread()], next_cursor: null })
  await Promise.all([first, second])
  expect(useSessionStore.getState().snapshot?.threads).toEqual([])
})

it('does not restart a healthy sync when an obsolete page expires', async () => {
  setIndex('expired-old-index')
  const page = deferred<SyncThreadPage>()
  useRelayStore.getState()._callRpc = vi.fn().mockReturnValue(page.promise) as typeof originalRpc
  const loading = loadSyncThreadPage('workspace-1')
  setIndex('healthy-new-index')
  page.reject(new Error('sync_index_expired'))
  await loading
  expect(useRelayStore.getState().hasSyncedOnce).toBe(true)
})

it('requests a fresh index when the current page expires', async () => {
  setIndex('expired-current-index')
  useRelayStore.getState()._callRpc = vi.fn().mockRejectedValue(new Error('sync_index_expired')) as typeof originalRpc
  await loadSyncThreadPage('workspace-1')
  expect(useRelayStore.getState().hasSyncedOnce).toBe(false)
})

it('starts page loading on the new socket without joining canceled old work', async () => {
  const token = 'reconnected-page-index'
  setIndex(token)
  const oldPage = deferred<SyncThreadPage>()
  const currentPage = deferred<SyncThreadPage>()
  const call = vi.fn().mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(currentPage.promise)
  useRelayStore.getState()._callRpc = call as typeof originalRpc
  useRelayStore.getState()._setSocket({} as WebSocket)
  const oldLoading = loadSyncThreadPage('workspace-1')
  useRelayStore.getState()._setSocket({} as WebSocket)
  const currentLoading = loadSyncThreadPage('workspace-1')
  oldPage.reject(new Error('sync_index_expired'))
  await oldLoading
  const duplicate = loadSyncThreadPage('workspace-1')
  currentPage.resolve({ token, workspace_id: 'workspace-1', threads: [thread()], next_cursor: null })
  await Promise.all([currentLoading, duplicate])
  expect(call).toHaveBeenCalledTimes(2)
  expect(currentLoading).toBe(duplicate)
  expect(useRelayStore.getState().hasSyncedOnce).toBe(true)
  expect(useSessionStore.getState().snapshot?.threads).toHaveLength(1)
})

it('discards extension responses from a previous socket without marking them loaded', async () => {
  const token = 'reconnected-extension-index'
  setIndex(token)
  const extensions = deferred<ExtensionSnapshot>()
  useRelayStore.getState()._callRpc = vi.fn().mockReturnValue(extensions.promise) as typeof originalRpc
  useRelayStore.getState()._setSocket({} as WebSocket)
  const loading = loadSyncExtensions(token)
  useRelayStore.getState()._setSocket({} as WebSocket)
  extensions.resolve({ catalog: [], views: [] })
  await loading
  expect(useSessionStore.getState().snapshot?.sync_index?.extensions_loaded).toBe(false)
})

it('does not force another sync when an extension request from the old socket expires', async () => {
  const token = 'expired-reconnected-extension-index'
  setIndex(token)
  const extensions = deferred<ExtensionSnapshot>()
  useRelayStore.getState()._callRpc = vi.fn().mockReturnValue(extensions.promise) as typeof originalRpc
  useRelayStore.getState()._setSocket({} as WebSocket)
  const loading = loadSyncExtensions(token)
  useRelayStore.getState()._setSocket({} as WebSocket)
  extensions.reject(new Error('sync_index_expired'))
  await loading
  expect(useRelayStore.getState().hasSyncedOnce).toBe(true)
})

it('joins current extension loads and lets a transient failure retry', async () => {
  const token = 'retry-extension-index'
  setIndex(token)
  const extensions = deferred<ExtensionSnapshot>()
  const call = vi.fn().mockReturnValueOnce(extensions.promise).mockResolvedValueOnce({ catalog: [], views: [] })
  useRelayStore.getState()._callRpc = call as typeof originalRpc
  const first = loadSyncExtensions(token)
  const duplicate = loadSyncExtensions(token)
  expect(first).toBe(duplicate)
  extensions.reject(new Error('Timed out waiting for a response'))
  await expect(first).rejects.toThrow('Timed out')
  expect(useRelayStore.getState().hasSyncedOnce).toBe(true)
  await loadSyncExtensions(token)
  expect(call).toHaveBeenCalledTimes(2)
  expect(useSessionStore.getState().snapshot?.sync_index?.extensions_loaded).toBe(true)
})

it('requests a fresh index when its current extension request expires', async () => {
  const token = 'expired-current-extension-index'
  setIndex(token)
  useRelayStore.getState()._callRpc = vi.fn().mockRejectedValue(new Error('sync_index_expired')) as typeof originalRpc
  await loadSyncExtensions(token)
  expect(useRelayStore.getState().hasSyncedOnce).toBe(false)
})

it('ignores page data after the relay session is replaced', async () => {
  const token = 'replaced-session-index'
  setIndex(token)
  const page = deferred<SyncThreadPage>()
  useRelayStore.getState()._callRpc = vi.fn().mockReturnValue(page.promise) as typeof originalRpc
  const loading = loadSyncThreadPage('workspace-1')
  useRelayStore.setState({ sessionId: 'session-2' })
  page.resolve({ token, workspace_id: 'workspace-1', threads: [thread()], next_cursor: null })
  await loading
  expect(useSessionStore.getState().snapshot?.threads).toEqual([])
})

it('does not refetch fully loaded extensions on reconnect, but fetches a new index', async () => {
  const token = 'loaded-extension-index'
  setIndex(token)
  const call = vi.fn().mockResolvedValue({ catalog: [], views: [] })
  useRelayStore.getState()._callRpc = call as typeof originalRpc
  useRelayStore.getState()._setSocket({} as WebSocket)
  await loadSyncExtensions(token)
  expect(useSessionStore.getState().snapshot?.sync_index?.extensions_loaded).toBe(true)
  useRelayStore.getState()._setSocket({} as WebSocket)
  await loadSyncExtensions(token)
  expect(call).toHaveBeenCalledOnce()

  setIndex('new-extension-index')
  await loadSyncExtensions('new-extension-index')
  expect(call).toHaveBeenCalledTimes(2)
  expect(useSessionStore.getState().snapshot?.sync_index?.extensions_loaded).toBe(true)
})
