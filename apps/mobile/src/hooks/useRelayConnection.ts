import { useCallback, useEffect, useRef, useState } from 'react'

import { normalizeEventEnvelope, normalizeDaemonSnapshot } from '@falcondeck/client-core'
import type {
  DaemonSnapshot,
  EventEnvelope,
  MachinePresence,
  RelayServerMessage,
  RelayUpdate,
  RelayWebSocketTicketResponse,
} from '@falcondeck/client-core'

import { useRelayStore, useSessionStore } from '@/store'

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

export function isInvalidSavedSessionError(message: string | null) {
  return !!message && /invalid session token|session not found|trusted device|failed with status 401|failed with status 404/i.test(
    message,
  )
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
  const pendingRelayUpdates = useRef<RelayUpdate[]>([])
  const relayFlushFrame = useRef<number | null>(null)
  const relayFlushTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const relayFlushInProgress = useRef(false)
  const snapshotRequestInFlight = useRef(false)
  const [reconnectGeneration, setReconnectGeneration] = useState(0)

  const requestSnapshot = useCallback(async () => {
    const relay = useRelayStore.getState()
    if (!relay._getSessionCrypto() || snapshotRequestInFlight.current) return

    snapshotRequestInFlight.current = true
    try {
      const nextSnapshot = normalizeDaemonSnapshot(
        await relay._callRpc<DaemonSnapshot>(
          'snapshot.current',
          { include_archived_threads: false },
          { requestIdPrefix: 'mobile-snapshot' },
        ),
      )
      useSessionStore.getState().applyDaemonEvents([
        {
          seq: 0,
          emitted_at: new Date().toISOString(),
          workspace_id: null,
          thread_id: null,
          event: { type: 'snapshot', snapshot: nextSnapshot },
        },
      ])
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

  const flushRelayUpdates = useCallback(async () => {
    if (relayFlushInProgress.current) return

    relayFlushInProgress.current = true

    try {
      while (pendingRelayUpdates.current.length > 0) {
        const relay = useRelayStore.getState()
        const batch = pendingRelayUpdates.current.splice(0)
        const daemonEvents: EventEnvelope[] = []
        let nextPresence: MachinePresence | null | undefined = undefined
        let shouldPersistCursor = false

        for (let index = 0; index < batch.length; index += 1) {
          const update = batch[index]
          relay._setLastReceivedSeq(update.seq)

          if (update.body.t === 'session-bootstrap') {
            await relay._processBootstrap(update)
            shouldPersistCursor = true
            if (pendingEncrypted.current.length > 0) {
              batch.splice(index + 1, 0, ...pendingEncrypted.current)
              pendingEncrypted.current = []
            }
            continue
          }

          if (update.body.t === 'presence') {
            nextPresence = update.body.presence
            shouldPersistCursor = true
            continue
          }

          if (update.body.t === 'action-status') {
            shouldPersistCursor = true
            continue
          }

          if (update.body.t !== 'encrypted') {
            continue
          }

          const sessionCrypto = relay._getSessionCrypto()
          if (!sessionCrypto) {
            pendingEncrypted.current.push(update)
            continue
          }

          try {
            const decrypted = await relay._decryptJson(update.body.envelope)
            const event = parseDaemonEvent(decrypted)
            if (event) {
              daemonEvents.push(event)
              shouldPersistCursor = true
            }
          } catch (e) {
            relay._setError(e instanceof Error ? e.message : 'Failed to decrypt update')
          }
        }

        if (nextPresence !== undefined) {
          relay._setMachinePresence(nextPresence)
        }

        if (daemonEvents.length > 0) {
          useSessionStore.getState().applyDaemonEvents(daemonEvents)
        }

        if (shouldPersistCursor) {
          relay._persistSession()
        }

        if (relay._getSessionCrypto() && !useSessionStore.getState().snapshot) {
          void requestSnapshot()
        }
      }
    } finally {
      relayFlushInProgress.current = false
      if (pendingRelayUpdates.current.length > 0 && relayFlushFrame.current === null && relayFlushTimeout.current === null) {
        if (globalThis.requestAnimationFrame) {
          relayFlushFrame.current = globalThis.requestAnimationFrame(() => {
            relayFlushFrame.current = null
            void flushRelayUpdates()
          })
        } else {
          relayFlushTimeout.current = globalThis.setTimeout(() => {
            relayFlushTimeout.current = null
            void flushRelayUpdates()
          }, 0)
        }
      }
    }
  }, [requestSnapshot])

  const scheduleRelayFlush = useCallback(() => {
    if (relayFlushFrame.current !== null || relayFlushTimeout.current !== null) {
      return
    }

    if (globalThis.requestAnimationFrame) {
      relayFlushFrame.current = globalThis.requestAnimationFrame(() => {
        relayFlushFrame.current = null
        void flushRelayUpdates()
      })
      return
    }

    relayFlushTimeout.current = globalThis.setTimeout(() => {
      relayFlushTimeout.current = null
      void flushRelayUpdates()
    }, 0)
  }, [flushRelayUpdates])

  useEffect(() => {
    const relay = useRelayStore.getState()
    if (!sessionId) return

    const clientToken = relay._getClientToken()
    if (!clientToken) return

    let isCurrent = true
    let shouldReconnect = true
    let activeSocket: WebSocket | null = null
    const relayUrl = relay.relayUrl.trim().replace(/\/$/, '')
    const wsUrl = relayUrl.startsWith('https://')
      ? `wss://${relayUrl.slice('https://'.length)}`
      : relayUrl.startsWith('http://')
        ? `ws://${relayUrl.slice('http://'.length)}`
        : relayUrl

    relay._setConnectionStatus('connecting')
    relay._setMachinePresence(null)
    relay._setError(null)
    pendingEncrypted.current = []
    pendingRelayUpdates.current = []
    snapshotRequestInFlight.current = false
    snapshotRetryAttempt.current = 0
    if (snapshotRetryTimer.current) {
      clearTimeout(snapshotRetryTimer.current)
      snapshotRetryTimer.current = null
    }
    if (relayFlushFrame.current !== null && globalThis.cancelAnimationFrame) {
      globalThis.cancelAnimationFrame(relayFlushFrame.current)
      relayFlushFrame.current = null
    }
    if (relayFlushTimeout.current !== null) {
      clearTimeout(relayFlushTimeout.current)
      relayFlushTimeout.current = null
    }

    const scheduleReconnect = () => {
      if (!isCurrent || !shouldReconnect || !useRelayStore.getState().sessionId) return
      relay._setConnectionStatus('disconnected')
      relay._setMachinePresence(null)
      relay._setSocket(null)
      relay._failPendingRpcs('Remote connection dropped')
      pendingEncrypted.current = []
      pendingRelayUpdates.current = []
      snapshotRequestInFlight.current = false
      snapshotRetryAttempt.current = 0
      if (snapshotRetryTimer.current) {
        clearTimeout(snapshotRetryTimer.current)
        snapshotRetryTimer.current = null
      }
      if (relayFlushFrame.current !== null && globalThis.cancelAnimationFrame) {
        globalThis.cancelAnimationFrame(relayFlushFrame.current)
        relayFlushFrame.current = null
      }
      if (relayFlushTimeout.current !== null) {
        clearTimeout(relayFlushTimeout.current)
        relayFlushTimeout.current = null
      }

      const delay = Math.min(1000 * 2 ** reconnectAttempt.current, 15_000)
      reconnectAttempt.current += 1
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = null
        setReconnectGeneration((value) => value + 1)
      }, delay)
    }

    const resetInvalidSavedSession = async (message: string) => {
      if (!shouldReconnect) return
      shouldReconnect = false
      await relay.disconnect()
      useRelayStore.getState()._setError(message)
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
          if (!isCurrent) return
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
                useSessionStore.getState().reset()
                if (relay._getSessionCrypto()) {
                  void requestSnapshot()
                }
                break
              }
              pendingRelayUpdates.current.push(...payload.updates)
              scheduleRelayFlush()
              break
            case 'update':
              pendingRelayUpdates.current.push(payload.update)
              scheduleRelayFlush()
              break
            case 'rpc-result':
              void processRpcResult(payload)
              break
            case 'presence':
              relay._setMachinePresence(payload.presence)
              break
            case 'error':
              relay._setError(payload.message)
              if (isInvalidSavedSessionError(payload.message)) {
                void resetInvalidSavedSession(payload.message)
              }
              break
          }
        }

        socket.onclose = () => {
          scheduleReconnect()
        }
      })
      .catch((error) => {
        if (!isCurrent) return
        const message = error instanceof Error ? error.message : 'Failed to connect to relay'
        relay._setError(message)
        if (isInvalidSavedSessionError(message)) {
          void resetInvalidSavedSession(message)
          return
        }
        scheduleReconnect()
      })

    return () => {
      isCurrent = false
      shouldReconnect = false
      activeSocket?.close()
      relay._setSocket(null)
      relay._failPendingRpcs('Remote connection closed')
      pendingEncrypted.current = []
      pendingRelayUpdates.current = []
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
      if (relayFlushFrame.current !== null && globalThis.cancelAnimationFrame) {
        globalThis.cancelAnimationFrame(relayFlushFrame.current)
        relayFlushFrame.current = null
      }
      if (relayFlushTimeout.current !== null) {
        clearTimeout(relayFlushTimeout.current)
        relayFlushTimeout.current = null
      }
    }
  }, [
    sessionId,
    reconnectGeneration,
    processRpcResult,
    requestSnapshot,
    scheduleRelayFlush,
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
