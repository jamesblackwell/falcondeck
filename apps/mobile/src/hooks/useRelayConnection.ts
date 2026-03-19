import { useEffect, useRef, useCallback, useState } from 'react'

import type {
  RelayServerMessage,
  RelayUpdate,
  EventEnvelope,
  DaemonSnapshot,
  ThreadDetail,
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
    return (payload as { event: EventEnvelope }).event
  }
  return null
}

export function useRelayConnection() {
  const sessionId = useRelayStore((s) => s.sessionId)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttempt = useRef(0)
  const pendingEncrypted = useRef<RelayUpdate[]>([])
  const [reconnectGeneration, setReconnectGeneration] = useState(0)

  const requestSnapshot = useCallback(async () => {
    const relay = useRelayStore.getState()
    if (!relay._getSessionCrypto()) return

    try {
      relay._sendMessage({
        type: 'rpc-call',
        request_id: `mobile-snapshot-${Date.now()}`,
        method: 'snapshot.current',
        params: await relay._encryptJson({}),
      })
    } catch (e) {
      relay._setError(e instanceof Error ? e.message : 'Failed to load snapshot')
    }
  }, [])

  const processRpcResult = useCallback(async (payload: Extract<RelayServerMessage, { type: 'rpc-result' }>) => {
    const relay = useRelayStore.getState()
    if (!payload.ok) {
      relay._setError('Remote action failed')
      return
    }

    if (!payload.result) return

    try {
      if (payload.request_id.startsWith('mobile-snapshot-')) {
        const snapshot = await relay._decryptJson<DaemonSnapshot>(payload.result)
        useSessionStore.getState().applyDaemonEvent({
          seq: 0,
          emitted_at: new Date().toISOString(),
          workspace_id: null,
          thread_id: null,
          event: { type: 'snapshot', snapshot },
        })
        return
      }

      if (payload.request_id.startsWith('mobile-detail-')) {
        const detail = await relay._decryptJson<ThreadDetail>(payload.result)
        useSessionStore.getState().setThreadDetail(detail)
      }
    } catch (e) {
      relay._setError(e instanceof Error ? e.message : 'Failed to process relay response')
    }
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
  }, [])

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

    const scheduleReconnect = () => {
      if (!isCurrent) return
      relay._setConnectionStatus('disconnected')
      relay._setSocket(null)
      pendingEncrypted.current = []

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
}
