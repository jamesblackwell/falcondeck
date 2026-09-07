import React from 'react'
import { AppState } from 'react-native'
import { act } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { decryptJson, encryptJson, expandSyncIndex, normalizeDaemonSnapshot, type RelayClientMessage, type RelayServerMessage } from '@falcondeck/client-core'
import { useRelayStore } from '@/store/relay-store'
import { useSessionStore } from '@/store/session-store'
import { assistantMessage, snapshot, snapshotEvent, threadDetail } from '@/test/factories'
import { cleanup, renderComponent } from '@/test/render'
import { restoreTestRelaySession } from '@/test/relay-session'
import { useRelayConnection } from './useRelayConnection'

// Only the network boundary is fake. RPC encryption, signed bootstrap
// verification, persistence, sync retry and the hook itself are production code.
class RelaySocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: RelaySocket[] = []
  readyState = RelaySocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  sent: RelayClientMessage[] = []
  send = (data: string) => { this.sent.push(JSON.parse(data) as RelayClientMessage) }
  close = vi.fn(() => { this.readyState = RelaySocket.CLOSED })
  constructor() { RelaySocket.instances.push(this) }
  receive(message: RelayServerMessage) {
    act(() => { this.onmessage?.({ data: JSON.stringify(message) }) })
  }
  bootstraps() {
    return this.sent.filter(message => message.type === 'ephemeral' &&
      (message.body as { kind?: string }).kind === 'request-bootstrap')
  }
  indexRequests() {
    return this.sent.filter((message): message is Extract<RelayClientMessage, { type: 'rpc-call' }> =>
      message.type === 'rpc-call' && message.method === 'sync.index')
  }
}

function Harness() { useRelayConnection(); return null }

beforeEach(() => {
  useSessionStore.getState().reset()
  useRelayStore.getState()._setSocket(null)
  useRelayStore.getState()._setSessionCrypto(null)
  RelaySocket.instances = []
  vi.stubGlobal('WebSocket', RelaySocket)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith('/push-token')) return { ok: true } as Response
    if (!String(input).includes('/ws-ticket')) throw new Error(`Unexpected fetch: ${input}`)
    return { ok: true, json: async () => ({ ticket: 'test-ticket' }) } as Response
  }))
})
afterEach(() => {
  cleanup()
  useRelayStore.getState()._setSocket(null)
  useRelayStore.getState()._setSessionCrypto(null)
  useSessionStore.getState().reset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function connect(savedKey: Uint8Array | null) {
  const fixture = await restoreTestRelaySession(savedKey)
  vi.useFakeTimers()
  renderComponent(<Harness />)
  await act(async () => { await vi.waitFor(() => expect(RelaySocket.instances).toHaveLength(1)) })
  const socket = RelaySocket.instances[0]!
  act(() => { socket.readyState = RelaySocket.OPEN; socket.onopen?.() })
  return { ...fixture, socket }
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

it.each(['snapshot-invalidated', 'history-truncated'] as const)(
  'repairs the open transcript after %s even though the socket and selection stay healthy',
  async (loss) => {
    const { socket, dataKey } = await connect(new Uint8Array(32).fill(42))
    const base = normalizeDaemonSnapshot(snapshot())
    const presence = { session_id: 'session', daemon_connected: true, daemon_rpc_ready: true, last_seen_at: null }
    socket.receive({ type: 'ready', session_id: 'session', role: 'client', next_seq: 11 })
    socket.receive({ type: 'sync', updates: [], next_seq: 11, history_truncated: false, presence })
    await advance(1)
    const indexResult = async (token: string) => encryptJson(dataKey, { token, snapshot: base,
      agent_catalogs: [], model_catalogs: [[]], workspace_agents: {}, workspace_models: {}, counts: {} })
    socket.receive({ type: 'rpc-result', request_id: socket.indexRequests()[0]!.request_id,
      ok: true, error: null, result: await indexResult('before-loss') })
    await advance(20)
    act(() => {
      useSessionStore.getState().selectThread('workspace-1', 'thread-1')
      useSessionStore.getState().setThreadDetail(threadDetail({
        items: [{ kind: 'assistant_message', id: 'reply', text: 'Half of the reply',
          created_at: '2026-03-16T10:01:00Z', lifecycle: 'streaming' }],
      }))
    })
    expect(useRelayStore.getState().hasSyncedOnce).toBe(true)

    // The daemon completed the reply, but its terminal update was lost.
    // Both recovery markers currently refresh only the sidebar/index.
    if (loss === 'snapshot-invalidated') {
      socket.receive({ type: 'update', update: {
        id: 'gap', seq: 12, created_at: new Date().toISOString(), body: { t: 'snapshot-invalidated' },
      } })
    } else {
      socket.receive({ type: 'sync', updates: [], next_seq: 13, history_truncated: true, presence })
    }
    await advance(20)
    expect(socket.indexRequests()).toHaveLength(2)
    socket.receive({ type: 'rpc-result', request_id: socket.indexRequests()[1]!.request_id,
      ok: true, error: null, result: await indexResult('after-loss') })
    await advance(20)
    expect(useRelayStore.getState()).toMatchObject({ isEncrypted: true, isSyncing: false })
    expect(useSessionStore.getState().selectedThreadId).toBe('thread-1')
    const detailCalls = socket.sent.filter((message): message is Extract<RelayClientMessage, { type: 'rpc-call' }> =>
      message.type === 'rpc-call' && message.method === 'thread.detail')
    expect(detailCalls).toHaveLength(1)
    socket.receive({ type: 'rpc-result', request_id: detailCalls[0]!.request_id, ok: true, error: null,
      result: await encryptJson(dataKey, threadDetail({ items: [assistantMessage('reply', 'The complete reply')] })) })
    await advance(20)
    expect(useSessionStore.getState().threadItems['thread-1']).toMatchObject([
      { id: 'reply', text: 'The complete reply', lifecycle: 'complete' },
    ])
  },
)

it('does not let presence traffic turn one failed index request into an immediate retry storm', async () => {
  const { socket } = await connect(new Uint8Array(32).fill(42))
  const presence = { session_id: 'session', daemon_connected: true, daemon_rpc_ready: true, last_seen_at: null }
  socket.receive({ type: 'sync', updates: [], next_seq: 11, history_truncated: false, presence })
  await advance(1)
  expect(socket.indexRequests()).toHaveLength(1)
  socket.receive({ type: 'rpc-result', request_id: socket.indexRequests()[0]!.request_id,
    ok: false, result: null, error: null, failure: 'timed_out' })
  await advance(1)
  expect(useRelayStore.getState().syncDiagnostics.nextRetryAt).not.toBeNull()
  for (let index = 0; index < 100; index += 1) socket.receive({ type: 'presence', presence })
  await advance(1)
  expect(socket.indexRequests()).toHaveLength(1)
  await advance(999)
  expect(socket.indexRequests()).toHaveLength(2)
})

it('probes a suspended OPEN socket on foreground and replaces it within three seconds if silent', async () => {
  let changeState: (state: 'background' | 'active') => void = () => { throw new Error('missing AppState listener') }
  vi.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    changeState = listener
    return { remove: vi.fn() }
  })
  const { socket } = await connect(new Uint8Array(32).fill(42))
  act(() => changeState('background'))
  await advance(5000)
  const sentBeforeForeground = socket.sent.length
  act(() => changeState('active'))
  expect(socket.sent.slice(sentBeforeForeground)).toContainEqual({ type: 'ping' })
  await advance(2999)
  expect(socket.close).not.toHaveBeenCalled()
  await advance(1)
  expect(socket.close).toHaveBeenCalledOnce()
  expect(RelaySocket.instances).toHaveLength(2)
})

it.each(['pong', 'presence'] as const)('keeps the foreground socket when %s confirms the path is alive', async (type) => {
  let changeState: (state: 'background' | 'active') => void = () => { throw new Error('missing AppState listener') }
  vi.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    changeState = listener
    return { remove: vi.fn() }
  })
  const { socket } = await connect(new Uint8Array(32).fill(42))
  act(() => changeState('background'))
  await advance(5000)
  act(() => changeState('active'))
  await advance(1000)
  if (type === 'pong') socket.receive({ type: 'pong' })
  else socket.receive({ type: 'presence', presence: {
    session_id: 'session', daemon_connected: false, daemon_rpc_ready: false, last_seen_at: null,
  } })
  await advance(3000)
  expect(socket.close).not.toHaveBeenCalled()
  expect(RelaySocket.instances).toHaveLength(1)
})

it('recovers from a malformed transport frame even when native close never emits onclose', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0)
  const { socket } = await connect(new Uint8Array(32).fill(42))
  socket.receive({ type: 'sync', updates: [], next_seq: 11, history_truncated: false,
    presence: { session_id: 'session', daemon_connected: true, daemon_rpc_ready: true, last_seen_at: null } })
  await advance(1)
  expect(socket.indexRequests()).toHaveLength(1)
  // A bad/incomplete transfer must terminate its pending requests now. The
  // native close event is not a prerequisite for our retry or recovery.
  act(() => socket.onmessage?.({ data: '{"type":"transport-chunk","id":7,"index":4,"total":8,"data":"bad"}' }))
  await advance(1)
  expect(socket.close).toHaveBeenCalledOnce()
  expect(useRelayStore.getState().connectionStatus).toBe('disconnected')
  expect(useRelayStore.getState().isSyncing).toBe(false)
  await advance(1000)
  expect(RelaySocket.instances).toHaveLength(2)
  expect(socket.indexRequests()).toHaveLength(1)
})

it('restarts interrupted extension hydration after reconnect even when the index token is unchanged', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0)
  const { socket } = await connect(new Uint8Array(32).fill(42))
  const base = normalizeDaemonSnapshot(snapshot())
  act(() => {
    useSessionStore.setState({ snapshot: expandSyncIndex({ token: 'same-index', snapshot: base,
      agent_catalogs: [], model_catalogs: [[]], workspace_agents: {}, workspace_models: {}, counts: {} }) })
    useRelayStore.getState()._finishSync()
  })
  const extensionCalls = (connection: RelaySocket) => connection.sent.filter(message =>
    message.type === 'rpc-call' && message.method === 'sync.extensions')
  await advance(1)
  expect(extensionCalls(socket)).toHaveLength(0)
  socket.receive({ type: 'ready', session_id: 'session', role: 'client', next_seq: 11 })
  await advance(1)
  expect(extensionCalls(socket)).toHaveLength(1)
  act(() => { socket.close(); socket.onclose?.() })
  await advance(1000)
  expect(RelaySocket.instances).toHaveLength(2)
  const replacement = RelaySocket.instances[1]!
  act(() => { replacement.readyState = RelaySocket.OPEN; replacement.onopen?.() })
  replacement.receive({ type: 'ready', session_id: 'session', role: 'client', next_seq: 11 })
  await advance(1)
  expect(extensionCalls(replacement)).toHaveLength(1)
  expect(useSessionStore.getState().snapshot?.sync_index?.token).toBe('same-index')
})

it('does not let a suspended decrypt from an old socket block the replacement socket bootstrap', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0)
  const { socket, bootstrap, dataKey } = await connect(new Uint8Array(32).fill(42))
  let finishOldDecrypt!: (text: string) => void
  const decrypt = vi.spyOn(useRelayStore.getState(), '_decryptUtf8').mockImplementationOnce(() =>
    new Promise<string>(resolve => { finishOldDecrypt = resolve }))
  socket.receive({ type: 'update', update: {
    id: 'old-encrypted', seq: 11, created_at: new Date().toISOString(),
    body: { t: 'encrypted', envelope: await encryptJson(dataKey, {}) },
  } })
  await advance(20)
  expect(decrypt).toHaveBeenCalledOnce()
  act(() => { socket.close(); socket.onclose?.() })
  await advance(1000)
  const replacement = RelaySocket.instances[1]!
  act(() => { replacement.readyState = RelaySocket.OPEN; replacement.onopen?.() })
  replacement.receive({ type: 'update', update: bootstrap(12) })
  try {
    await advance(20)
    expect(useRelayStore.getState().isEncrypted).toBe(true)
  } finally {
    finishOldDecrypt('{}')
    await advance(1)
  }
  expect(useRelayStore.getState().isEncrypted).toBe(true)
  expect(useRelayStore.getState()._getSocket()).toBe(replacement)
})

it('retries a lost bootstrap every five seconds, stops after success, and cleans up on unmount', async () => {
  const { socket, bootstrap } = await connect(null)
  expect(socket.bootstraps()).toHaveLength(1)
  await advance(4999)
  expect(socket.bootstraps()).toHaveLength(1)
  await advance(1)
  expect(socket.bootstraps()).toHaveLength(2)
  await advance(5000)
  expect(socket.bootstraps()).toHaveLength(3)
  socket.receive({ type: 'update', update: bootstrap() })
  await advance(100)
  expect(useRelayStore.getState().isEncrypted).toBe(true)
  await advance(10_000)
  expect(socket.bootstraps()).toHaveLength(3)
  cleanup()
  const sentAtUnmount = socket.sent.length
  await advance(10_000)
  expect(socket.sent).toHaveLength(sentAtUnmount)
  expect(socket.close).toHaveBeenCalledOnce()
})

it('keeps recovery available after a healthy connection has been idle with a key', async () => {
  const { socket } = await connect(new Uint8Array(32).fill(42))
  await advance(10_000)
  expect(socket.bootstraps()).toHaveLength(0)
  act(() => useRelayStore.getState()._recoverSessionCrypto(useRelayStore.getState()._getSessionCrypto()!))
  expect(socket.bootstraps()).toHaveLength(1)
  // Simulate a lost immediate request. The still-running timer must retry.
  await advance(5000)
  expect(socket.bootstraps()).toHaveLength(2)
})

it('automatically replaces a stale saved key and finishes sync on the same socket', async () => {
  useSessionStore.getState().applyDaemonEvents([snapshotEvent(snapshot())])
  useSessionStore.setState({ selectedWorkspaceId: 'workspace-1', selectedThreadId: 'thread-1' })
  const cachedSnapshot = useSessionStore.getState().snapshot
  const { socket, bootstrap, dataKey } = await connect(new Uint8Array(32).fill(13))
  socket.receive({ type: 'sync', updates: [], next_seq: 11, history_truncated: false,
    presence: { session_id: 'session', daemon_connected: true, daemon_rpc_ready: true, last_seen_at: null } })
  await act(async () => { await vi.waitFor(() => expect(socket.indexRequests()).toHaveLength(1)) })
  const first = socket.indexRequests()[0]!
  socket.receive({ type: 'rpc-result', request_id: first.request_id, ok: false, result: null,
    error: await encryptJson(dataKey, { message: 'invalid remote rpc payload' }) })
  await act(async () => { await vi.waitFor(() => expect(socket.bootstraps()).toHaveLength(1)) })
  expect(useRelayStore.getState()._getSessionCrypto()).toBeNull()
  expect(useRelayStore.getState().hasSyncedOnce).toBe(false)
  expect(useSessionStore.getState().snapshot).toBe(cachedSnapshot)
  expect(useSessionStore.getState().selectedThreadId).toBe('thread-1')
  socket.receive({ type: 'update', update: bootstrap() })
  await act(async () => { await vi.waitFor(() => expect(socket.indexRequests()).toHaveLength(2)) })
  const retry = socket.indexRequests()[1]!
  // The outgoing retry must genuinely use the repaired key, not just show
  // an "encrypted" status while continuing to send unusable requests.
  await expect(decryptJson(dataKey, retry.params)).resolves.toMatchObject({ selected_thread_id: 'thread-1' })
  const base = normalizeDaemonSnapshot(snapshot())
  socket.receive({ type: 'rpc-result', request_id: retry.request_id, ok: true, error: null,
    result: await encryptJson(dataKey, { token: 'recovered-index', snapshot: base,
      agent_catalogs: [], model_catalogs: [[]], workspace_agents: {}, workspace_models: {}, counts: {} }) })
  await act(async () => { await vi.waitFor(() => expect(useRelayStore.getState().hasSyncedOnce).toBe(true)) })
  expect(useRelayStore.getState()).toMatchObject({ isEncrypted: true, isSyncing: false, error: null })
  expect(useSessionStore.getState().snapshot?.workspaces).toEqual(base.workspaces)
  expect(useSessionStore.getState().snapshot?.sync_index?.token).toBe('recovered-index')
  expect(useSessionStore.getState().selectedThreadId).toBe('thread-1')
  await advance(5000)
  expect(socket.indexRequests()).toHaveLength(2)
  expect(socket.bootstraps()).toHaveLength(1)
  expect(RelaySocket.instances).toHaveLength(1)
  expect(socket.close).not.toHaveBeenCalled()
})
