import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { __resetAllStores as resetMMKV } from 'react-native-mmkv'

import { setJson } from '@/storage/mmkv'
import { useRelayStore } from '@/store/relay-store'
import { useSessionStore } from '@/store/session-store'
import { snapshot, snapshotEvent, thread, workspace } from '@/test/factories'
import { createNotificationRouter } from './notification-routing'

const originalRpc = useRelayStore.getState()._callRpc
let router: ReturnType<typeof createNotificationRouter>
let rpc: ReturnType<typeof vi.fn>

const destination = { sessionId: 'session-1', workspaceId: 'workspace-1', threadId: 'not-cached' }
const resolvedHandle = () => ({ workspace: workspace(), thread: thread({ id: 'not-cached' }) })

function deferredHandle() {
  let resolve!: (handle: ReturnType<typeof resolvedHandle>) => void
  const promise = new Promise<ReturnType<typeof resolvedHandle>>(done => { resolve = done })
  return { promise, resolve }
}

function connect() {
  useRelayStore.getState()._setSocket({ readyState: 1 } as WebSocket)
  useRelayStore.getState()._setSessionCrypto({ dataKey: new Uint8Array(32), material: null })
  useRelayStore.setState({
    hasSyncedOnce: true,
    isEncrypted: true,
    machinePresence: {
      session_id: 'session-1', daemon_connected: true, daemon_rpc_ready: true, last_seen_at: null,
    },
  })
}

beforeEach(() => {
  resetMMKV()
  setJson('relay.session', { sessionId: 'session-1' })
  useSessionStore.getState().reset()
  useSessionStore.getState().applyDaemonEvent(snapshotEvent(snapshot()))
  useSessionStore.getState().selectThread('workspace-1', 'thread-1')
  rpc = vi.fn()
  useRelayStore.setState({
    sessionId: 'session-1', isEncrypted: false, hasSyncedOnce: false, machinePresence: null, _callRpc: rpc,
  })
  router = createNotificationRouter()
})

afterEach(() => {
  router.dispose()
  useRelayStore.setState({ _callRpc: originalRpc })
  useRelayStore.getState()._setSocket(null)
  useRelayStore.getState()._setSessionCrypto(null)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('opens a cached destination immediately without an RPC', async () => {
  expect(await router.select({ ...destination, threadId: 'thread-1' })).toBe(true)
  expect(useSessionStore.getState().selectedThreadId).toBe('thread-1')
  expect(rpc).not.toHaveBeenCalled()
})

it('keeps a tap while reconnecting and selects it when a daemon event supplies the thread', async () => {
  const selected = router.select(destination)
  expect(useSessionStore.getState().selectedThreadId).toBe('thread-1')
  expect(rpc).not.toHaveBeenCalled()

  useSessionStore.getState().applyDaemonEvent(snapshotEvent(snapshot({
    threads: [thread(), thread({ id: 'not-cached' })],
  })))
  expect(await selected).toBe(true)
  expect(useSessionStore.getState().selectedThreadId).toBe('not-cached')
})

it('waits for the first snapshot instead of letting it reconcile away an uncached selection', async () => {
  useSessionStore.getState().reset()
  const selected = router.select(destination)
  expect(useSessionStore.getState().selectedThreadId).toBeNull()
  useSessionStore.getState().applyDaemonEvent(snapshotEvent(snapshot({
    threads: [thread(), thread({ id: 'not-cached' })],
  })))
  expect(await selected).toBe(true)
  expect(useSessionStore.getState().selectedThreadId).toBe('not-cached')
})

it('resolves an older thread omitted by compact sync and preserves workspace catalogs', async () => {
  const originalWorkspace = useSessionStore.getState().snapshot!.workspaces[0]
  rpc.mockResolvedValue(resolvedHandle())
  const selected = router.select(destination)
  expect(rpc).not.toHaveBeenCalled()
  connect()

  expect(await selected).toBe(true)
  expect(rpc).toHaveBeenCalledWith('thread.detail', expect.objectContaining({
    workspace_id: 'workspace-1', thread_id: 'not-cached', mode: 'tail', limit: 1,
    inline_images: false, strict_limit: true, compact_workspace: true,
  }), { requestIdPrefix: 'mobile-notification' })
  expect(useSessionStore.getState().snapshot!.workspaces[0]).toBe(originalWorkspace)
  expect(useSessionStore.getState().selectedThreadId).toBe('not-cached')
})

it('lets a newer tap cancel an older destination still being resolved', async () => {
  const old = deferredHandle()
  rpc.mockReturnValue(old.promise)
  connect()
  const oldSelection = router.select(destination)
  expect(await router.select({ ...destination, threadId: 'thread-1' })).toBe(true)
  expect(await oldSelection).toBe(false)

  old.resolve(resolvedHandle())
  await old.promise
  expect(useSessionStore.getState().selectedThreadId).toBe('thread-1')
  expect(useSessionStore.getState().snapshot!.threads.some(thread => thread.id === 'not-cached')).toBe(false)
})

it('does not override a sidebar selection made while a tap waits for reconnection', async () => {
  const selected = router.select(destination)
  useSessionStore.getState().selectNewThread('workspace-1')
  expect(await selected).toBe(false)
  rpc.mockResolvedValue(resolvedHandle())
  connect()
  expect(rpc).not.toHaveBeenCalled()
  expect(useSessionStore.getState().selectedThreadId).toBeNull()
})

it('ignores a resolution from a previous relay connection and retries on the new one', async () => {
  const old = deferredHandle()
  const current = deferredHandle()
  rpc.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
  connect()
  const selected = router.select(destination)
  connect()
  expect(rpc).toHaveBeenCalledTimes(2)

  old.resolve(resolvedHandle())
  await old.promise
  expect(useSessionStore.getState().selectedThreadId).toBe('thread-1')
  current.resolve(resolvedHandle())
  expect(await selected).toBe(true)
  expect(useSessionStore.getState().selectedThreadId).toBe('not-cached')
})

it('drops a pending destination when the paired session changes', async () => {
  const old = deferredHandle()
  rpc.mockReturnValue(old.promise)
  connect()
  const selected = router.select(destination)
  useRelayStore.setState({ sessionId: 'session-2' })
  expect(await selected).toBe(false)
  old.resolve(resolvedHandle())
  await old.promise
  expect(useSessionStore.getState().selectedThreadId).toBe('thread-1')
})

it.each([
  { workspace: workspace(), thread: thread({ id: 'not-cached', is_archived: true }) },
  { workspace: workspace(), thread: thread({ id: 'different-thread' }) },
  { workspace: workspace(), thread: thread({ id: 'not-cached', workspace_id: 'wrong-workspace' }) },
])('rejects an archived or mismatched daemon destination', async handle => {
  rpc.mockResolvedValue(handle)
  connect()
  expect(await router.select(destination)).toBe(false)
  expect(useSessionStore.getState().selectedThreadId).toBe('thread-1')
})

it('retries a transient RPC failure without losing the destination', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  rpc.mockRejectedValueOnce(new Error('Lost the relay connection')).mockResolvedValueOnce(resolvedHandle())
  connect()
  const selected = router.select(destination)
  await vi.advanceTimersByTimeAsync(2000)
  expect(await selected).toBe(true)
  expect(rpc).toHaveBeenCalledTimes(2)
  expect(useSessionStore.getState().selectedThreadId).toBe('not-cached')
})

it('reports a deleted thread without selecting another conversation', async () => {
  rpc.mockRejectedValue(new Error('thread not found'))
  connect()
  expect(await router.select(destination)).toBe(false)
  expect(useRelayStore.getState().error).toBe('This conversation is no longer available.')
  expect(useSessionStore.getState().selectedThreadId).toBe('thread-1')
})
