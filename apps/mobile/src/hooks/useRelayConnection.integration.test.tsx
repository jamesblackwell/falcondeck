import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildPairingPublicKeyBundle,
  generateBoxKeyPair,
  type EncryptedEnvelope,
} from '@falcondeck/client-core'

import { useRelayStore } from '@/store/relay-store'
import { useSessionStore } from '@/store/session-store'
import {
  assistantMessage,
  conversationItemAddedEvent,
  snapshot,
  snapshotEvent,
} from '@/test/factories'
import { cleanup, renderComponent } from '@/test/render'

import { useRelayConnection } from './useRelayConnection'

const originalFailPendingRpcs = useRelayStore.getState()._failPendingRpcs
const originalDecryptJson = useRelayStore.getState()._decryptJson
const originalCallRpc = useRelayStore.getState()._callRpc

class TestWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: TestWebSocket[] = []

  readonly url: string
  readyState = TestWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  send = vi.fn()
  close = vi.fn(() => {
    this.readyState = TestWebSocket.CLOSED
  })

  constructor(url: string) {
    this.url = url
    TestWebSocket.instances.push(this)
  }
}

function claimResponse(index: number) {
  return {
    pairing_id: `pairing-${index}`,
    session_id: `session-${index}`,
    device_id: `device-${index}`,
    client_token: `token-${index}`,
    trusted_device: {
      device_id: `device-${index}`,
      session_id: `session-${index}`,
      label: 'FalconDeck iPhone',
      status: 'active',
      created_at: '2026-08-09T12:00:00Z',
      last_seen_at: '2026-08-09T12:00:00Z',
      revoked_at: null,
    },
    daemon_bundle: buildPairingPublicKeyBundle(generateBoxKeyPair()),
  }
}

function RelayConnectionHarness() {
  useRelayConnection()
  return null
}

function renderRelayConnection() {
  return renderComponent(<RelayConnectionHarness />)
}

describe('useRelayConnection session rotation', () => {
  beforeEach(() => {
    TestWebSocket.instances = []
    vi.stubGlobal('WebSocket', TestWebSocket)
    useSessionStore.getState().reset()
    useRelayStore.getState()._setSocket(null)
    useRelayStore.getState()._setSessionCrypto(null)
    useRelayStore.setState({
      relayUrl: 'https://relay.test',
      pairingCode: '',
      sessionId: null,
      deviceId: null,
      connectionStatus: 'not_connected',
      machinePresence: null,
      error: null,
      isConnected: false,
      isEncrypted: false,
      isSyncing: false,
      hasSyncedOnce: false,
      syncDiagnostics: {
        startedAt: null,
        attempt: 0,
        lastAttemptAt: null,
        nextRetryAt: null,
        lastError: null,
        lastErrorAt: null,
        lastSuccessAt: null,
      },
    })
  })

  afterEach(() => {
    cleanup()
    useRelayStore.getState()._failPendingRpcs = originalFailPendingRpcs
    useRelayStore.getState()._decryptJson = originalDecryptJson
    useRelayStore.getState()._callRpc = originalCallRpc
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('closes the old socket and reconnects with only the new session credentials', async () => {
    let claimIndex = 0
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/v1/pairings/challenge')) {
        return {
          ok: true,
          json: async () => ({
            pairing_id: `pairing-${claimIndex + 1}`,
            challenge: 'dGVzdC1jaGFsbGVuZ2U=',
          }),
        } as Response
      }
      if (url.endsWith('/v1/pairings/claim')) {
        claimIndex += 1
        return { ok: true, json: async () => claimResponse(claimIndex) } as Response
      }
      if (url.includes('/ws-ticket')) {
        const session = url.match(/sessions\/(session-\d+)\//)?.[1]
        return { ok: true, json: async () => ({ ticket: `ticket-${session}` }) } as Response
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? 'GET'}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    useRelayStore.getState().setPairingCode('FIRST')
    await act(async () => {
      await useRelayStore.getState().claimPairing()
    })

    const failPendingRpcs = vi.fn()
    useRelayStore.getState()._failPendingRpcs = failPendingRpcs

    renderRelayConnection()

    await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(1))
    const oldSocket = TestWebSocket.instances[0]!
    expect(oldSocket.url).toContain('session_id=session-1')
    expect(oldSocket.url).toContain('ticket=ticket-session-1')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://relay.test/v1/sessions/session-1/ws-ticket',
      expect.objectContaining({
        headers: { authorization: 'Bearer token-1' },
      }),
    )

    useRelayStore.getState().setPairingCode('SECOND')
    await act(async () => {
      await useRelayStore.getState().claimPairing()
    })

    await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(2))
    const newSocket = TestWebSocket.instances[1]!
    // The pairing store closes immediately when it adopts new credentials,
    // and the hook cleanup defensively closes its captured socket again.
    expect(oldSocket.close).toHaveBeenCalled()
    expect(failPendingRpcs).toHaveBeenCalledWith('Relay connection closed')
    expect(newSocket.url).toContain('session_id=session-2')
    expect(newSocket.url).toContain('ticket=ticket-session-2')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://relay.test/v1/sessions/session-2/ws-ticket',
      expect.objectContaining({
        headers: { authorization: 'Bearer token-2' },
      }),
    )
  })

  it('ignores an old session ticket that resolves after the session rotates', async () => {
    let claimIndex = 0
    let resolveOldTicket!: (response: Response) => void
    const oldTicket = new Promise<Response>((resolve) => {
      resolveOldTicket = resolve
    })
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/v1/pairings/challenge')) {
        return {
          ok: true,
          json: async () => ({ challenge: 'dGVzdC1jaGFsbGVuZ2U=' }),
        } as Response
      }
      if (url.endsWith('/v1/pairings/claim')) {
        claimIndex += 1
        return { ok: true, json: async () => claimResponse(claimIndex) } as Response
      }
      if (url.includes('/sessions/session-1/ws-ticket')) return oldTicket
      if (url.includes('/sessions/session-2/ws-ticket')) {
        return { ok: true, json: async () => ({ ticket: 'new-ticket' }) } as Response
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    useRelayStore.getState().setPairingCode('FIRST')
    await act(async () => {
      await useRelayStore.getState().claimPairing()
    })

    renderRelayConnection()
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://relay.test/v1/sessions/session-1/ws-ticket',
        expect.anything(),
      )
    })

    useRelayStore.getState().setPairingCode('SECOND')
    await act(async () => {
      await useRelayStore.getState().claimPairing()
    })
    await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(1))
    expect(TestWebSocket.instances[0]?.url).toContain('session_id=session-2')

    resolveOldTicket({ ok: true, json: async () => ({ ticket: 'stale-ticket' }) } as Response)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(TestWebSocket.instances).toHaveLength(1)
    expect(TestWebSocket.instances[0]?.url).not.toContain('stale-ticket')
  })

  it('cancels an old display frame so its encrypted delta cannot enter the new session', async () => {
    let claimIndex = 0
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/v1/pairings/challenge')) {
        return {
          ok: true,
          json: async () => ({ challenge: 'dGVzdC1jaGFsbGVuZ2U=' }),
        } as Response
      }
      if (url.endsWith('/v1/pairings/claim')) {
        claimIndex += 1
        return { ok: true, json: async () => claimResponse(claimIndex) } as Response
      }
      if (url.includes('/ws-ticket')) {
        return { ok: true, json: async () => ({ ticket: `ticket-${claimIndex}` }) } as Response
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    let queuedFrame: FrameRequestCallback | null = null
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      queuedFrame = callback
      return 91
    })
    const cancelFrame = vi.fn()
    vi.stubGlobal('requestAnimationFrame', requestFrame)
    vi.stubGlobal('cancelAnimationFrame', cancelFrame)

    useRelayStore.getState().setPairingCode('FIRST')
    await act(async () => {
      await useRelayStore.getState().claimPairing()
    })

    renderRelayConnection()
    await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(1))

    useRelayStore.getState()._setSessionCrypto({ dataKey: new Uint8Array(32), material: null })
    useRelayStore.getState()._decryptJson = vi.fn().mockResolvedValue({
      kind: 'daemon-event',
      event: {
        seq: 1,
        emitted_at: '2026-08-09T12:00:00Z',
        workspace_id: 'workspace-1',
        thread_id: 'thread-1',
        event: {
          type: 'conversation-item-added',
          item: {
            kind: 'assistant_message',
            id: 'stale-answer',
            text: 'This belongs to the old session',
            created_at: '2026-08-09T12:00:00Z',
          },
        },
      },
    })

    const oldSocket = TestWebSocket.instances[0]!
    act(() => {
      oldSocket.onmessage?.({
        data: JSON.stringify({
          type: 'update',
          update: {
            id: 'update-1',
            seq: 1,
            body: { t: 'encrypted', envelope: { nonce: 'old', ciphertext: 'old' } },
            created_at: '2026-08-09T12:00:00Z',
          },
        }),
      })
    })
    expect(queuedFrame).not.toBeNull()

    useRelayStore.getState().setPairingCode('SECOND')
    await act(async () => {
      await useRelayStore.getState().claimPairing()
    })
    await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(2))
    expect(cancelFrame).toHaveBeenCalledWith(91)

    await act(async () => {
      queuedFrame?.(performance.now())
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(useSessionStore.getState().threadItems['thread-1']).toBeUndefined()
  })

  it('holds updates that arrive during decryption for the next display frame', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/v1/pairings/challenge')) {
        return {
          ok: true,
          json: async () => ({ challenge: 'dGVzdC1jaGFsbGVuZ2U=' }),
        } as Response
      }
      if (url.endsWith('/v1/pairings/claim')) {
        return { ok: true, json: async () => claimResponse(1) } as Response
      }
      if (url.includes('/ws-ticket')) {
        return { ok: true, json: async () => ({ ticket: 'frame-ticket' }) } as Response
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const queuedFrames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback)
      return queuedFrames.length
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    useRelayStore.getState().setPairingCode('FRAME')
    await act(async () => {
      await useRelayStore.getState().claimPairing()
    })
    useSessionStore.getState().applyDaemonEvents([snapshotEvent(snapshot())])

    renderRelayConnection()
    await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(1))

    useRelayStore.getState()._setSessionCrypto({ dataKey: new Uint8Array(32), material: null })
    let resolveFirstDecrypt!: (value: unknown) => void
    const firstDecrypt = new Promise<unknown>((resolve) => {
      resolveFirstDecrypt = resolve
    })
    const firstEvent = conversationItemAddedEvent(
      assistantMessage('frame-one', 'First frame'),
    )
    const secondEvent = conversationItemAddedEvent(
      assistantMessage('frame-two', 'Second frame'),
    )
    const decryptJson = vi.fn(async <T,>(envelope: EncryptedEnvelope): Promise<T> => {
      if (envelope.ciphertext === 'first') return await firstDecrypt as T
      return { kind: 'daemon-event', event: secondEvent } as T
    })
    useRelayStore.getState()._decryptJson = decryptJson as unknown as typeof originalDecryptJson

    const socket = TestWebSocket.instances[0]!
    const sendEncryptedUpdate = (seq: number, nonce: string) => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'update',
          update: {
            id: `update-${seq}`,
            seq,
            body: {
              t: 'encrypted',
              envelope: { encryption_variant: 'data_key_v1', ciphertext: nonce },
            },
            created_at: '2026-08-09T12:00:00Z',
          },
        }),
      })
    }

    act(() => sendEncryptedUpdate(1, 'first'))
    expect(queuedFrames).toHaveLength(1)

    await act(async () => {
      queuedFrames.shift()?.(performance.now())
      await Promise.resolve()
    })
    expect(decryptJson).toHaveBeenCalledTimes(1)

    act(() => sendEncryptedUpdate(2, 'second'))
    expect(queuedFrames).toHaveLength(1)

    await act(async () => {
      resolveFirstDecrypt({ kind: 'daemon-event', event: firstEvent })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(decryptJson).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().threadItems['thread-1']).toEqual([
      expect.objectContaining({ id: 'frame-one' }),
    ])

    await act(async () => {
      queuedFrames.shift()?.(performance.now())
      await vi.waitFor(() => expect(decryptJson).toHaveBeenCalledTimes(2))
    })
    expect(useSessionStore.getState().threadItems['thread-1']).toEqual([
      expect.objectContaining({ id: 'frame-one' }),
      expect.objectContaining({ id: 'frame-two' }),
    ])
  })

  it('checkpoints a decrypted update after its raced snapshot is replaced', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/v1/pairings/challenge')) {
        return {
          ok: true,
          json: async () => ({ challenge: 'dGVzdC1jaGFsbGVuZ2U=' }),
        } as Response
      }
      if (url.endsWith('/v1/pairings/claim')) {
        return { ok: true, json: async () => claimResponse(1) } as Response
      }
      if (url.includes('/ws-ticket')) {
        return { ok: true, json: async () => ({ ticket: 'snapshot-race-ticket' }) } as Response
      }
      if (url.endsWith('/push-token')) {
        return { ok: true } as Response
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const queuedFrames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback)
      return queuedFrames.length
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    useRelayStore.getState().setPairingCode('SNAPSHOT-RACE')
    await act(async () => {
      await useRelayStore.getState().claimPairing()
    })
    useRelayStore.getState()._setSessionCrypto({ dataKey: new Uint8Array(32), material: null })

    let resolveFirstSnapshot!: (value: ReturnType<typeof snapshot>) => void
    const firstSnapshot = new Promise<ReturnType<typeof snapshot>>((resolve) => {
      resolveFirstSnapshot = resolve
    })
    const callRpc = vi
      .fn()
      .mockReturnValueOnce(firstSnapshot)
      .mockResolvedValueOnce(snapshot())
    useRelayStore.getState()._callRpc = callRpc as typeof originalCallRpc

    let resolveDecrypt!: (value: unknown) => void
    const pendingDecrypt = new Promise<unknown>((resolve) => {
      resolveDecrypt = resolve
    })
    useRelayStore.getState()._decryptJson = vi
      .fn()
      .mockReturnValue(pendingDecrypt) as typeof originalDecryptJson

    renderRelayConnection()
    await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(1))

    const socket = TestWebSocket.instances[0]!
    socket.readyState = TestWebSocket.OPEN
    act(() => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'ready' }) })
    })
    expect(callRpc).not.toHaveBeenCalled()
    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'sync',
          updates: [],
          next_seq: 1,
          history_truncated: false,
          presence: {
            session_id: 'session-1',
            daemon_connected: true,
            daemon_rpc_ready: true,
            last_seen_at: null,
          },
        }),
      })
    })
    await vi.waitFor(() => expect(callRpc).toHaveBeenCalledTimes(1))

    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'update',
          update: {
            id: 'raced-update',
            seq: 7,
            body: {
              t: 'encrypted',
              envelope: { encryption_variant: 'data_key_v1', ciphertext: 'raced' },
            },
            created_at: '2026-08-09T12:00:00Z',
          },
        }),
      })
    })
    await act(async () => {
      queuedFrames.shift()?.(performance.now())
      await Promise.resolve()
    })

    // The snapshot response loses the race to the still-running decrypt and
    // must be replaced rather than committed as an older base.
    await act(async () => {
      resolveFirstSnapshot(snapshot())
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(useSessionStore.getState().snapshot).toBeNull()

    await act(async () => {
      resolveDecrypt({
        kind: 'daemon-event',
        event: conversationItemAddedEvent(
          assistantMessage('raced-answer', 'Recovered by replacement snapshot'),
        ),
      })
      await vi.waitFor(() => expect(callRpc).toHaveBeenCalledTimes(2))
    })
    await vi.waitFor(() => expect(useSessionStore.getState().snapshot).not.toBeNull())

    expect(useRelayStore.getState()._getLastReceivedSeq()).toBe(7)
  })

  it('recovers an empty truncated replay with a snapshot and durable cursor', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/v1/pairings/challenge')) {
        return {
          ok: true,
          json: async () => ({ challenge: 'dGVzdC1jaGFsbGVuZ2U=' }),
        } as Response
      }
      if (url.endsWith('/v1/pairings/claim')) {
        return { ok: true, json: async () => claimResponse(1) } as Response
      }
      if (url.includes('/ws-ticket')) {
        return { ok: true, json: async () => ({ ticket: 'truncation-ticket' }) } as Response
      }
      if (url.endsWith('/push-token')) {
        return { ok: true } as Response
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const queuedFrames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback)
      return queuedFrames.length
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    useRelayStore.getState().setPairingCode('TRUNCATED')
    await act(async () => {
      await useRelayStore.getState().claimPairing()
    })
    useRelayStore.getState()._setSessionCrypto({ dataKey: new Uint8Array(32), material: null })
    useRelayStore.getState()._setLastReceivedSeq(0)

    const callRpc = vi.fn().mockResolvedValue(snapshot())
    useRelayStore.getState()._callRpc = callRpc as typeof originalCallRpc

    renderRelayConnection()
    await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(1))

    const socket = TestWebSocket.instances[0]!
    socket.readyState = TestWebSocket.OPEN
    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'sync',
          updates: [],
          next_seq: 42,
          history_truncated: true,
          presence: {
            session_id: 'session-1',
            daemon_connected: true,
            daemon_rpc_ready: true,
            last_seen_at: null,
          },
        }),
      })
      await vi.waitFor(() => expect(callRpc).toHaveBeenCalledWith(
        'snapshot.current',
        expect.anything(),
        expect.anything(),
      ))
      await vi.waitFor(() => expect(useRelayStore.getState()._getLastReceivedSeq()).toBe(41))
    })

    await act(async () => {
      queuedFrames.shift()?.(performance.now())
      await Promise.resolve()
    })

    expect(socket.close).not.toHaveBeenCalled()
    expect(useSessionStore.getState().snapshot).not.toBeNull()
    expect(useRelayStore.getState().hasSyncedOnce).toBe(true)
    expect(useRelayStore.getState().isSyncing).toBe(false)
  })

  it('keeps sync presence when replay contains an older offline state', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/v1/pairings/challenge')) {
        return {
          ok: true,
          json: async () => ({ challenge: 'dGVzdC1jaGFsbGVuZ2U=' }),
        } as Response
      }
      if (url.endsWith('/v1/pairings/claim')) {
        return { ok: true, json: async () => claimResponse(1) } as Response
      }
      if (url.includes('/ws-ticket')) {
        return { ok: true, json: async () => ({ ticket: 'presence-ticket' }) } as Response
      }
      if (url.endsWith('/push-token')) {
        return { ok: true } as Response
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const queuedFrames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback)
      return queuedFrames.length
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    useRelayStore.getState().setPairingCode('PRESENCE')
    await act(async () => {
      await useRelayStore.getState().claimPairing()
    })
    useRelayStore.getState()._setSessionCrypto({ dataKey: new Uint8Array(32), material: null })
    useRelayStore.getState()._callRpc = vi.fn().mockResolvedValue(snapshot()) as typeof originalCallRpc

    renderRelayConnection()
    await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(1))

    const socket = TestWebSocket.instances[0]!
    socket.readyState = TestWebSocket.OPEN
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'ready' }) })
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'sync',
          next_seq: 7,
          history_truncated: false,
          presence: {
            session_id: 'session-1',
            daemon_connected: true,
            daemon_rpc_ready: true,
            last_seen_at: '2026-08-18T21:38:00Z',
          },
          updates: [{
            id: 'stale-offline-presence',
            seq: 6,
            created_at: '2026-08-18T21:37:00Z',
            body: {
              t: 'presence',
              presence: {
                session_id: 'session-1',
                daemon_connected: false,
                daemon_rpc_ready: false,
                last_seen_at: '2026-08-18T21:37:00Z',
              },
            },
          }],
        }),
      })
      queuedFrames.shift()?.(performance.now())
      await Promise.resolve()
    })

    expect(useRelayStore.getState().machinePresence).toMatchObject({
      daemon_connected: true,
      daemon_rpc_ready: true,
    })
  })

  it('still fetches a snapshot when the offline cache already hydrated one', async () => {
    // Warm start: the cache paints projects before the socket opens. Guarding
    // the fetch on "no snapshot" used to skip it entirely, so hasSyncedOnce
    // never flipped and the syncing banner hung forever over stale threads.
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/v1/pairings/challenge')) {
        return {
          ok: true,
          json: async () => ({ challenge: 'dGVzdC1jaGFsbGVuZ2U=' }),
        } as Response
      }
      if (url.endsWith('/v1/pairings/claim')) {
        return { ok: true, json: async () => claimResponse(1) } as Response
      }
      if (url.includes('/ws-ticket')) {
        return { ok: true, json: async () => ({ ticket: 'warm-start-ticket' }) } as Response
      }
      if (url.endsWith('/push-token')) {
        return { ok: true } as Response
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    useRelayStore.getState().setPairingCode('WARM-START')
    await act(async () => {
      await useRelayStore.getState().claimPairing()
    })
    useRelayStore.getState()._setSessionCrypto({ dataKey: new Uint8Array(32), material: null })

    act(() => {
      useSessionStore.getState().applyDaemonEvents([snapshotEvent(snapshot())])
    })
    expect(useSessionStore.getState().snapshot).not.toBeNull()
    expect(useRelayStore.getState().hasSyncedOnce).toBe(false)

    const callRpc = vi.fn().mockResolvedValue(snapshot())
    useRelayStore.getState()._callRpc = callRpc as typeof originalCallRpc

    renderRelayConnection()
    await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(1))

    const socket = TestWebSocket.instances[0]!
    socket.readyState = TestWebSocket.OPEN
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'ready' }) })
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'sync',
          updates: [],
          next_seq: 1,
          history_truncated: false,
          presence: {
            session_id: 'session-1',
            daemon_connected: true,
            daemon_rpc_ready: true,
            last_seen_at: null,
          },
        }),
      })
      await vi.waitFor(() => expect(callRpc).toHaveBeenCalledWith(
        'snapshot.current',
        expect.anything(),
        expect.anything(),
      ))
      await vi.waitFor(() => expect(useRelayStore.getState().hasSyncedOnce).toBe(true))
    })
    expect(useRelayStore.getState().isSyncing).toBe(false)
  })

  it('keeps a transient snapshot failure out of the error toast and retries to success', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/v1/pairings/challenge')) {
        return {
          ok: true,
          json: async () => ({ challenge: 'dGVzdC1jaGFsbGVuZ2U=' }),
        } as Response
      }
      if (url.endsWith('/v1/pairings/claim')) {
        return { ok: true, json: async () => claimResponse(1) } as Response
      }
      if (url.includes('/ws-ticket')) {
        return { ok: true, json: async () => ({ ticket: 'flap-ticket' }) } as Response
      }
      if (url.endsWith('/push-token')) {
        return { ok: true } as Response
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    useRelayStore.getState().setPairingCode('FLAP-RETRY')
    await act(async () => {
      await useRelayStore.getState().claimPairing()
    })
    useRelayStore.getState()._setSessionCrypto({ dataKey: new Uint8Array(32), material: null })

    const failure = 'Desktop disconnected from the relay.'
    const callRpc = vi
      .fn()
      .mockRejectedValueOnce(new Error(failure))
      .mockResolvedValue(snapshot())
    useRelayStore.getState()._callRpc = callRpc as typeof originalCallRpc

    // The retry can land within the same flush, so observe the transient
    // states through a subscription instead of sampling between awaits.
    const seenToasts: (string | null)[] = []
    const seenSyncErrors: (string | null)[] = []
    const unsubscribe = useRelayStore.subscribe((state) => {
      seenToasts.push(state.error)
      seenSyncErrors.push(state.syncDiagnostics.lastError)
    })

    renderRelayConnection()
    await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(1))

    const socket = TestWebSocket.instances[0]!
    socket.readyState = TestWebSocket.OPEN
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'ready' }) })
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'sync',
          updates: [],
          next_seq: 1,
          history_truncated: false,
          presence: {
            session_id: 'session-1',
            daemon_connected: true,
            daemon_rpc_ready: true,
            last_seen_at: null,
          },
        }),
      })
      await vi.waitFor(() => expect(callRpc).toHaveBeenCalledTimes(1))
    })

    // The retry lands and clears the diagnostics.
    await act(async () => {
      await vi.waitFor(() => expect(useRelayStore.getState().hasSyncedOnce).toBe(true), {
        timeout: 3_000,
      })
    })
    unsubscribe()

    // The failure fed the sync banner's diagnostics, never the red toast.
    expect(seenSyncErrors).toContain(failure)
    expect(seenToasts.filter((toast) => toast !== null)).toEqual([])
    expect(useRelayStore.getState().error).toBeNull()
    expect(useRelayStore.getState().syncDiagnostics.lastError).toBeNull()
    expect(useRelayStore.getState().isSyncing).toBe(false)
  })

  it('re-issues a snapshot deferred while desktop was offline once presence recovers', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/v1/pairings/challenge')) {
        return {
          ok: true,
          json: async () => ({ challenge: 'dGVzdC1jaGFsbGVuZ2U=' }),
        } as Response
      }
      if (url.endsWith('/v1/pairings/claim')) {
        return { ok: true, json: async () => claimResponse(1) } as Response
      }
      if (url.includes('/ws-ticket')) {
        return { ok: true, json: async () => ({ ticket: 'deferred-ticket' }) } as Response
      }
      if (url.endsWith('/push-token')) {
        return { ok: true } as Response
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    useRelayStore.getState().setPairingCode('DEFERRED')
    await act(async () => {
      await useRelayStore.getState().claimPairing()
    })
    useRelayStore.getState()._setSessionCrypto({ dataKey: new Uint8Array(32), material: null })

    const callRpc = vi.fn().mockResolvedValue(snapshot())
    useRelayStore.getState()._callRpc = callRpc as typeof originalCallRpc

    renderRelayConnection()
    await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(1))

    const socket = TestWebSocket.instances[0]!
    socket.readyState = TestWebSocket.OPEN
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'ready' }) })
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'sync',
          updates: [],
          next_seq: 1,
          history_truncated: false,
          presence: {
            session_id: 'session-1',
            daemon_connected: true,
            daemon_rpc_ready: true,
            last_seen_at: null,
          },
        }),
      })
      await vi.waitFor(() => expect(useRelayStore.getState().hasSyncedOnce).toBe(true))
    })
    expect(callRpc).toHaveBeenCalledTimes(1)

    // History truncation demands a recovery snapshot, but desktop is offline:
    // the request must defer, keep the syncing state, and fire when desktop
    // comes back — not latch "Syncing…" forever.
    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'sync',
          updates: [],
          next_seq: 2,
          history_truncated: true,
          presence: {
            session_id: 'session-1',
            daemon_connected: false,
            daemon_rpc_ready: false,
            last_seen_at: null,
          },
        }),
      })
    })
    expect(callRpc).toHaveBeenCalledTimes(1)
    expect(useRelayStore.getState().isSyncing).toBe(true)

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'presence',
          presence: {
            session_id: 'session-1',
            daemon_connected: true,
            daemon_rpc_ready: true,
            last_seen_at: null,
          },
        }),
      })
      await vi.waitFor(() => expect(callRpc).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(useRelayStore.getState().isSyncing).toBe(false))
    })
    expect(useRelayStore.getState().error).toBeNull()
  })
})
