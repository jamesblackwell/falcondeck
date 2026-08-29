import { afterEach, describe, expect, it, vi } from 'vitest'

const cryptoMocks = vi.hoisted(() => ({
  bootstrapSessionCrypto: vi.fn((_keyPair: unknown, material: unknown) => ({
    dataKey: new Uint8Array(32).fill(11),
    material,
  })),
  verifySessionKeyMaterial: vi.fn(),
}))

vi.mock('./crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./crypto')>()),
  bootstrapSessionCrypto: cryptoMocks.bootstrapSessionCrypto,
  verifySessionKeyMaterial: cryptoMocks.verifySessionKeyMaterial,
}))

import {
  buildPairingPublicKeyBundle,
  bytesToBase64,
  deriveIdentityKeyPair,
  encryptJson,
  generateBoxKeyPair,
  identityPublicKeyToBase64,
  publicKeyToBase64,
  restoreBoxKeyPair,
  secretKeyToBase64,
} from './crypto'
import { RemoteHostClient } from './remote-host-client'
import {
  REMOTE_SESSION_STORAGE_VERSION,
  type PersistedRemoteSession,
} from './remote-session'
import type { MachinePresence, SessionKeyMaterial } from './types'

class TestWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: TestWebSocket[] = []

  readyState = TestWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  send = vi.fn()
  close = vi.fn(() => {
    this.readyState = TestWebSocket.CLOSED
  })

  constructor(readonly url: string) {
    TestWebSocket.instances.push(this)
  }
}

const clients: RemoteHostClient[] = []

afterEach(() => {
  clients.splice(0).forEach((client) => client.stop())
  TestWebSocket.instances = []
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function persistedSession(dataKey: string | null = null): PersistedRemoteSession {
  const clientKeyPair = generateBoxKeyPair()
  const daemonKeyPair = generateBoxKeyPair()
  return {
    version: REMOTE_SESSION_STORAGE_VERSION,
    relayUrl: 'https://relay.example',
    pairingCode: 'ABCD1234',
    pairingId: 'pairing-1',
    sessionId: 'session-1',
    deviceId: 'device-1',
    clientToken: 'client-token',
    clientSecretKey: secretKeyToBase64(clientKeyPair),
    daemonPublicKey: publicKeyToBase64(daemonKeyPair),
    daemonIdentityPublicKey: identityPublicKeyToBase64(
      deriveIdentityKeyPair(daemonKeyPair),
    ),
    dataKey,
    lastReceivedSeq: 0,
  }
}

async function startClient(
  session: PersistedRemoteSession,
  callbacks: ConstructorParameters<typeof RemoteHostClient>[1] = {},
) {
  vi.stubGlobal('WebSocket', TestWebSocket)
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ ticket: 'ticket-1' }),
  } as Response)
  const client = new RemoteHostClient(session, callbacks)
  clients.push(client)
  client.start()
  await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(1))
  const socket = TestWebSocket.instances[0]!
  socket.readyState = TestWebSocket.OPEN
  socket.onopen?.()
  return { client, socket }
}

function sendServerMessage(socket: TestWebSocket, message: unknown) {
  socket.onmessage?.({ data: JSON.stringify(message) })
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function encryptedRealtimeEvent(dataKey: Uint8Array, seq: number) {
  return encryptJson(dataKey, {
    kind: 'daemon-event',
    event: {
      seq,
      emitted_at: `2026-08-21T07:00:0${seq}Z`,
      workspace_id: 'workspace-1',
      thread_id: 'thread-1',
      event: {
        type: 'realtime-item-added',
        item: {
          id: `realtime-${seq}`,
          item_type: 'voice',
          title: `Realtime ${seq}`,
          summary: null,
          payload: null,
          created_at: `2026-08-21T07:00:0${seq}Z`,
        },
      },
    },
  })
}

async function encryptedDurableEvent(dataKey: Uint8Array, seq: number) {
  return encryptJson(dataKey, {
    kind: 'daemon-event',
    event: {
      seq,
      emitted_at: `2026-08-21T07:00:0${seq}Z`,
      workspace_id: 'workspace-1',
      thread_id: 'thread-1',
      event: { type: 'stop', reason: null },
    },
  })
}

describe('RemoteHostClient relay replay', () => {
  it('persists the cursor advanced by a bootstrap-only replay batch', async () => {
    const session = persistedSession()
    const storedClientKeyPair = buildPairingPublicKeyBundle(
      restoreBoxKeyPair(session.clientSecretKey),
    )
    const material: SessionKeyMaterial = {
      encryption_variant: 'data_key_v1',
      identity_variant: 'ed25519_v1',
      pairing_id: 'pairing-2',
      session_id: session.sessionId,
      daemon_public_key: session.daemonPublicKey!,
      daemon_identity_public_key: session.daemonIdentityPublicKey!,
      client_public_key: storedClientKeyPair.public_key,
      client_identity_public_key: storedClientKeyPair.identity_public_key,
      client_wrapped_data_key: {
        encryption_variant: 'data_key_v1',
        wrapped_key: bytesToBase64(new Uint8Array(32)),
      },
      daemon_wrapped_data_key: null,
      signature: 'fixture-signature',
    }
    const onSessionChanged = vi.fn()
    const { client, socket } = await startClient(session, { onSessionChanged })

    sendServerMessage(socket, {
      type: 'sync',
      next_seq: 13,
      history_truncated: false,
      updates: [
        {
          id: 'bootstrap-12',
          seq: 12,
          created_at: '2026-08-21T07:00:00Z',
          body: { t: 'session-bootstrap', material },
        },
      ],
    })

    await vi.waitFor(() => expect(client.currentSession.lastReceivedSeq).toBe(12))
    expect(Reflect.get(client, 'bootstrapRetryInterval')).toBeNull()
    expect(onSessionChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ dataKey: expect.any(String), lastReceivedSeq: 12 }),
    )
  })

  it('does not let older replay presence overwrite authoritative sync presence', async () => {
    const online: MachinePresence = {
      session_id: 'session-1',
      daemon_connected: true,
      daemon_rpc_ready: true,
      last_seen_at: null,
    }
    const offline: MachinePresence = {
      ...online,
      daemon_connected: false,
      daemon_rpc_ready: false,
    }
    const presenceChanges: Array<MachinePresence | null> = []
    const { client, socket } = await startClient(
      persistedSession(bytesToBase64(new Uint8Array(32).fill(7))),
      { onPresence: (presence) => presenceChanges.push(presence) },
    )

    sendServerMessage(socket, {
      type: 'sync',
      next_seq: 7,
      history_truncated: false,
      presence: online,
      updates: [
        {
          id: 'stale-presence',
          seq: 6,
          created_at: '2026-08-21T07:00:00Z',
          body: { t: 'presence', presence: offline },
        },
      ],
    })

    await vi.waitFor(() => expect(client.currentSession.lastReceivedSeq).toBe(6))
    expect(client.presence).toEqual(online)
    expect(presenceChanges.filter((presence) => presence !== null)).toEqual([online])
  })

  it('does not allocate a bootstrap retry timer when the data key is already persisted', async () => {
    const { client } = await startClient(
      persistedSession(bytesToBase64(new Uint8Array(32).fill(7))),
    )

    expect(Reflect.get(client, 'bootstrapRetryInterval')).toBeNull()
  })

  it('waits for one live event callback before delivering the next event', async () => {
    const dataKey = new Uint8Array(32).fill(7)
    const firstApply = deferred()
    const secondApplyStarted = deferred()
    const applied: number[] = []
    const { socket } = await startClient(
      persistedSession(bytesToBase64(dataKey)),
      {
        onEvents: async (events) => {
          applied.push(events[0]?.seq ?? -1)
          if (events[0]?.seq === 1) await firstApply.promise
          if (events[0]?.seq === 2) secondApplyStarted.resolve()
        },
      },
    )

    sendServerMessage(socket, {
      type: 'ephemeral',
      body: {
        kind: 'encrypted-daemon-event',
        envelope: await encryptedRealtimeEvent(dataKey, 1),
      },
    })
    await vi.waitFor(() => expect(applied).toEqual([1]))
    sendServerMessage(socket, {
      type: 'ephemeral',
      body: {
        kind: 'encrypted-daemon-event',
        envelope: await encryptedRealtimeEvent(dataKey, 2),
      },
    })

    const deliveredWhileFirstWasBlocked = await Promise.race([
      secondApplyStarted.promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 200)),
    ])
    expect(deliveredWhileFirstWasBlocked).toBe(false)
    firstApply.resolve()
    await vi.waitFor(() => expect(applied).toEqual([1, 2]))
  })

  it('rejects an encrypted RPC result when its connection closes during decryption', async () => {
    const dataKey = new Uint8Array(32).fill(7)
    const { client, socket } = await startClient(
      persistedSession(bytesToBase64(dataKey)),
    )
    const result = client.rpc<{ source: string }>('thread.detail', {})
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(2))
    const request = JSON.parse(String(socket.send.mock.calls[1]?.[0])) as {
      request_id: string
    }

    sendServerMessage(socket, {
      type: 'rpc-result',
      request_id: request.request_id,
      ok: true,
      result: await encryptJson(dataKey, { source: 'closed-connection' }),
      error: null,
    })
    socket.onclose?.()

    await expect(result).rejects.toThrow('Relay connection closed')
  })

  it('flushes replay received after a restart while the old event callback settles', async () => {
    const dataKey = new Uint8Array(32).fill(7)
    const firstApply = deferred()
    const applied: number[] = []
    const { client, socket: firstSocket } = await startClient(
      persistedSession(bytesToBase64(dataKey)),
      {
        onEvents: async (events) => {
          applied.push(events[0]?.seq ?? -1)
          if (events[0]?.seq === 1) await firstApply.promise
        },
      },
    )

    sendServerMessage(firstSocket, {
      type: 'sync',
      next_seq: 2,
      history_truncated: false,
      updates: [{
        id: 'event-1',
        seq: 1,
        created_at: '2026-08-21T07:00:01Z',
        body: { t: 'encrypted', envelope: await encryptedDurableEvent(dataKey, 1) },
      }],
    })
    await vi.waitFor(() => expect(applied).toEqual([1]))

    client.stop()
    client.start()
    await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(2))
    const secondSocket = TestWebSocket.instances[1]!
    secondSocket.readyState = TestWebSocket.OPEN
    secondSocket.onopen?.()
    sendServerMessage(secondSocket, {
      type: 'sync',
      next_seq: 3,
      history_truncated: false,
      updates: [{
        id: 'event-2',
        seq: 2,
        created_at: '2026-08-21T07:00:02Z',
        body: { t: 'encrypted', envelope: await encryptedDurableEvent(dataKey, 2) },
      }],
    })

    firstApply.resolve()
    await vi.waitFor(() => expect(applied).toEqual([1, 2]))
  })
})
