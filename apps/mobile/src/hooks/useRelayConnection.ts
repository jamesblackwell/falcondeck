import { useEffect, useRef, useCallback, useState } from 'react'

import { normalizeEventEnvelope, normalizeDaemonSnapshot } from '@falcondeck/client-core'
import type {
  RelayServerMessage,
  RelayUpdate,
  EventEnvelope,
  DaemonSnapshot,
  RelayWebSocketTicketResponse,
} from '@falcondeck/client-core'

import { useRelayStore } from '@/store'
import { useSessionStore } from '@/store'

function parseDaemonEvent(payload: unknown): EventEnvelope | null {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'kind' in payload &&
    'event' in payload &&
    (payload as { kind?: string }).kind === 'daemon-event'
  ) {
    return normalizeEventEnvelope((payload as { event: EventEnvelope }).event)
  }
  return null
}

export function useRelayConnection() {
  const sessionId = useRelayStore((s) => s.sessionId)
  const isEncrypted = useRelayStore((s) => s.isEncrypted)
  const snapshot = useSessionStore((s) => s.snapshot)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const snapshotRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const snapshotRetryAttempt = useRef(0)
  const reconnectAttempt = useRef(0)
  const pendingEncrypted = useRef<RelayUpdate[]>([])
  const snapshotRequestInFlight = useRef(false)
  const [reconnectGeneration, setReconnectGeneration] = useState(0)

  const requestSnapshot = useCallback(async () => {
    const relay = useRelayStore.getState()
    if (!relay._getSessionCrypto() || snapshotRequestInFlight.current) return

    snapshotRequestInFlight.current = true
    try {
      const snapshot = normalizeDaemonSnapshot(
        await relay._callRpc<DaemonSnapshot>('snapshot.current', {}, {
          requestIdPrefix: 'mobile-snapshot',
        }),
      )
      useSessionStore.getState().applyDaemonEvent({
        seq: 0,
        emitted_at: new Date().toISOString(),
        workspace_id: null,
        thread_id: null,
        event: { type: 'snapshot', snapshot },
      })
      snapshotRetryAttempt.current = 0
      if (snapshotRetryTimer.current) {
        clearTimeout(snapshotRetryTimer.current)
        snapshotRetryTimer.current = null
      }
      relay._setError(null)
    } catch (e) {
      relay._setError(e instanceof Error ? e.message : 'Failed to load snapshot')
      if (!useSessionStore.getState().snapshot && !snapshotRetryTimer.current) {
        const delay = Math.min(1000 * 2 ** snapshotRetryAttempt.current, 5_000)
        snapshotRetryAttempt.current += 1
        snapshotRetryTimer.current = setTimeout(() => {
          snapshotRetryTimer.current = null
          void requestSnapshot()
        }, delay)
      }
    } finally {
      snapshotRequestInFlight.current = false
    }
  }, [])

  const processRpcResult = useCallback(async (payload: Extract<RelayServerMessage, { type: 'rpc-result' }>) => {
    const relay = useRelayStore.getState()
    if (await relay._handleRpcResult(payload)) {
      return
    }
    if (!payload.ok) relay._setError('Remote action failed')
  }, [])

  const processUpdate = useCallback(async (update: RelayUpdate) => {
    const relay = useRelayStore.getState()
    relay._setLastReceivedSeq(update.seq)

    if (update.body.t === 'session-bootstrap') {
      await relay._processBootstrap(update)
      // Process any queued encrypted updates
      const queued = pendingEncrypted.current
      pendingEncrypted.current = []
      for (const u of queued) await processUpdate(u)
      if (relay._getSessionCrypto() && !useSessionStore.getState().snapshot) {
        void requestSnapshot()
      }
      return
    }

    if (update.body.t === 'presence') {
      relay._setMachinePresence(update.body.presence)
      relay._persistSession()
      return
    }

    if (update.body.t === 'action-status') {
      relay._persistSession()
      return
    }

    if (update.body.t !== 'encrypted') return

    const sc = relay._getSessionCrypto()
    if (!sc) {
      pendingEncrypted.current.push(update)
      return
    }

    try {
      const decrypted = await relay._decryptJson(update.body.envelope)
      const event = parseDaemonEvent(decrypted)
      if (event) {
        useSessionStore.getState().applyDaemonEvent(event)
      }
      relay._persistSession()
    } catch (e) {
      relay._setError(e instanceof Error ? e.message : 'Failed to decrypt update')
    }
  }, [requestSnapshot])

  useEffect(() => {
    const relay = useRelayStore.getState()
    if (!sessionId) return

    const clientToken = relay._getClientToken()
    if (!clientToken) return

    let isCurrent = true
    let activeSocket: WebSocket | null = null
    const relayUrl = relay.relayUrl.trim().replace(/\/$/, '')
    const wsUrl = relayUrl.startsWith('https://')
      ? `wss://${relayUrl.slice('https://'.length)}`
      : relayUrl.startsWith('http://')
        ? `ws://${relayUrl.slice('http://'.length)}`
        : relayUrl
    relay._setConnectionStatus('connecting')
    relay._setError(null)
    pendingEncrypted.current = []
    snapshotRequestInFlight.current = false
    snapshotRetryAttempt.current = 0
    if (snapshotRetryTimer.current) {
      clearTimeout(snapshotRetryTimer.current)
      snapshotRetryTimer.current = null
    }

    const scheduleReconnect = () => {
      if (!isCurrent) return
      relay._setConnectionStatus('disconnected')
      relay._setSocket(null)
      relay._failPendingRpcs('Remote connection dropped')
      pendingEncrypted.current = []
      snapshotRequestInFlight.current = false
      snapshotRetryAttempt.current = 0
      if (snapshotRetryTimer.current) {
        clearTimeout(snapshotRetryTimer.current)
        snapshotRetryTimer.current = null
      }

      const delay = Math.min(1000 * 2 ** reconnectAttempt.current, 15_000)
      reconnectAttempt.current += 1
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = null
        setReconnectGeneration((value) => value + 1)
      }, delay)
    }

    void fetch(`${relayUrl}/v1/sessions/${encodeURIComponent(sessionId)}/ws-ticket`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${clientToken}`,
      },
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null
          throw new Error(payload?.error ?? `Failed with status ${response.status}`)
        }
        return response.json() as Promise<RelayWebSocketTicketResponse>
      })
      .then((ticket) => {
        if (!isCurrent) return
        const socket = new WebSocket(
          `${wsUrl}/v1/updates/ws?session_id=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket.ticket)}`,
        )
        activeSocket = socket

        relay._setSocket(socket)

        socket.onopen = () => {
          reconnectAttempt.current = 0
          relay._setConnectionStatus('connected')
          relay._sendMessage({ type: 'sync', after_seq: relay._getLastReceivedSeq() })
        }

        socket.onmessage = (msg) => {
          let payload: RelayServerMessage
          try {
            payload = JSON.parse(msg.data) as RelayServerMessage
          } catch {
            relay._setError('Received malformed relay message')
            socket.close()
            return
          }
          switch (payload.type) {
            case 'ready':
              if (relay._getSessionCrypto()) {
                relay._setConnectionStatus('encrypted')
                if (!useSessionStore.getState().snapshot) {
                  void requestSnapshot()
                }
              }
              break
            case 'sync':
              if (payload.history_truncated) {
                relay._setLastReceivedSeq(Math.max(payload.next_seq - 1, 0))
                relay._persistSession()
                useSessionStore.setState((state) => ({
                  ...state,
                  snapshot: null,
                  threadDetail: null,
                  threadItems: {},
                }))
                if (relay._getSessionCrypto()) {
                  void requestSnapshot()
                }
              }
              for (const u of payload.updates) void processUpdate(u)
              break
            case 'update':
              void processUpdate(payload.update)
              break
            case 'rpc-result':
              void processRpcResult(payload)
              break
            case 'presence':
              relay._setMachinePresence(payload.presence)
              break
            case 'error':
              relay._setError(payload.message)
              break
          }
        }

        socket.onclose = () => {
          scheduleReconnect()
        }
      })
      .catch((error) => {
        if (!isCurrent) return
        relay._setError(error instanceof Error ? error.message : 'Failed to connect to relay')
        scheduleReconnect()
      })

    return () => {
      isCurrent = false
      activeSocket?.close()
      relay._setSocket(null)
      relay._failPendingRpcs('Remote connection closed')
      snapshotRequestInFlight.current = false
      snapshotRetryAttempt.current = 0
      if (snapshotRetryTimer.current) {
        clearTimeout(snapshotRetryTimer.current)
        snapshotRetryTimer.current = null
      }
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
        reconnectTimer.current = null
      }
    }
  }, [
    sessionId,
    reconnectGeneration,
    processRpcResult,
    processUpdate,
    requestSnapshot,
  ])

  useEffect(() => {
    if (!sessionId || !isEncrypted || snapshot) {
      return
    }

    const relay = useRelayStore.getState()
    const socket = relay._getSocket()
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return
    }

    void requestSnapshot()
  }, [isEncrypted, requestSnapshot, sessionId, snapshot])
}
