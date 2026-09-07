import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { decryptJson, encryptJson, normalizeDaemonSnapshot, type RelayClientMessage, type RelayServerMessage } from '@falcondeck/client-core'
import { useRelayStore } from '@/store/relay-store'
import { useSessionStore } from '@/store/session-store'
import { snapshot, snapshotEvent } from '@/test/factories'
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
