import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'

import { normalizeEventEnvelope, normalizeDaemonSnapshot } from '@falcondeck/client-core'
import type {
  DaemonSnapshot,
  EventEnvelope,
  MachinePresence,
  RelayServerMessage,
  RelayUpdate,
  RelayWebSocketTicketResponse,
} from '@falcondeck/client-core'

import { registerPushToken } from '@/lib/push-notifications'
import { useRelayStore, useSessionStore } from '@/store'

// The relay disconnects peers silent for 45s; the daemon pings every 15s.
const RELAY_PING_INTERVAL_MS = 15_000
// Only treat a connection as healthy (and reset backoff) after it stays open this long.
const RELAY_BACKOFF_RESET_MS = 10_000
const MAX_PENDING_ENCRYPTED_UPDATES = 1_000

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

/**
 * iOS kills the relay socket when the app backgrounds; waiting for the dead
 * socket to error plus the backoff delay makes resume feel slow. When the app
 * returns to the foreground and the socket is not OPEN, reconnect immediately.
 * Transitions away from 'active' do nothing — the OS tears the socket down.
 */
export function shouldReconnectOnAppForeground(
  nextAppState: string,
  socketReadyState: number | null,
) {
  return nextAppState === 'active' && socketReadyState !== WebSocket.OPEN
}

export function isInvalidSavedSessionError(message: string | null) {
  return !!message && /invalid session token|session not found|trusted device|failed with status 401|failed with status 404/i.test(
    message,
  )
}

export function useRelayConnection() {
  const sessionId = useRelayStore((s) => s.sessionId)
  const deviceId = useRelayStore((s) => s.deviceId)
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
  const snapshotAfterCrypto = useRef(false)
  const [reconnectGeneration, setReconnectGeneration] = useState(0)

  const requestSnapshot = useCallback(async () => {
    const relay = useRelayStore.getState()
    if (!relay._getSessionCrypto() || snapshotRequestInFlight.current) return

    snapshotRequestInFlight.current = true
    let shouldRefetch = false
    try {
      const cursorAtRequest = relay._getLastReceivedSeq()
      const nextSnapshot = normalizeDaemonSnapshot(
        await relay._callRpc<DaemonSnapshot>(
          'snapshot.current',
          { include_archived_threads: false },
          { requestIdPrefix: 'mobile-snapshot' },
        ),
      )
      if (useRelayStore.getState()._getLastReceivedSeq() > cursorAtRequest) {
        // Incremental events landed while the RPC was in flight; applying this
        // response could clobber them, so fetch a fresh snapshot instead.
        shouldRefetch = true
        return
      }
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
      if (shouldRefetch) {
        void requestSnapshot()
      }
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

        // The cursor may only advance for updates that were actually consumed;
        // otherwise a parked or failed update can never be replayed by a later
        // sync. While updates are parked the cursor must stay before them.
        const advanceCursor = (seq: number) => {
          if (pendingEncrypted.current.length > 0) return
          relay._setLastReceivedSeq(seq)
          shouldPersistCursor = true
        }

        for (let index = 0; index < batch.length; index += 1) {
          const update = batch[index]

          if (update.body.t === 'session-bootstrap') {
            await relay._processBootstrap(update)
            if (pendingEncrypted.current.length > 0) {
              batch.splice(index + 1, 0, ...pendingEncrypted.current)
              pendingEncrypted.current = []
            }
            advanceCursor(update.seq)
            if (snapshotAfterCrypto.current && relay._getSessionCrypto()) {
              snapshotAfterCrypto.current = false
              void requestSnapshot()
            }
            continue
          }

          if (update.body.t === 'presence') {
            nextPresence = update.body.presence
            advanceCursor(update.seq)
            continue
          }

          if (update.body.t === 'action-status') {
            advanceCursor(update.seq)
            continue
          }

          if (update.body.t !== 'encrypted') {
            advanceCursor(update.seq)
            continue
          }

          const sessionCrypto = relay._getSessionCrypto()
          if (!sessionCrypto) {
            if (pendingEncrypted.current.length >= MAX_PENDING_ENCRYPTED_UPDATES) {
              console.warn('Dropping oldest parked encrypted relay update; buffer is full')
              pendingEncrypted.current.shift()
            }
            pendingEncrypted.current.push(update)
            continue
          }

          try {
            const decrypted = await relay._decryptJson(update.body.envelope)
            advanceCursor(update.seq)
            const event = parseDaemonEvent(decrypted)
            if (event) {
              daemonEvents.push(event)
            }
          } catch (e) {
            // Leave the cursor behind this update so a later sync replays it.
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
    let pingInterval: ReturnType<typeof setInterval> | null = null
    let backoffResetTimer: ReturnType<typeof setTimeout> | null = null
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

    const clearSocketTimers = () => {
      if (pingInterval !== null) {
        clearInterval(pingInterval)
        pingInterval = null
      }
      if (backoffResetTimer !== null) {
        clearTimeout(backoffResetTimer)
        backoffResetTimer = null
      }
    }

    const scheduleReconnect = () => {
      clearSocketTimers()
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

      const base = Math.min(1000 * 2 ** reconnectAttempt.current, 15_000)
      reconnectAttempt.current += 1
      const delay = Math.round(base * (0.8 + Math.random() * 0.4))
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

    // iOS kills the socket on background; on foreground, skip the dead-socket
    // error + backoff dance and reconnect right away. Leaving 'active' does
    // nothing — the OS tears the socket down naturally.
    const appStateSubscription = AppState.addEventListener('change', (nextAppState) => {
      if (!isCurrent || !shouldReconnect) return
      if (!shouldReconnectOnAppForeground(nextAppState, activeSocket?.readyState ?? null)) return
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
        reconnectTimer.current = null
      }
      reconnectAttempt.current = 0
      setReconnectGeneration((value) => value + 1)
    })

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
          // The relay drops peers that stay silent for 45s.
          pingInterval = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'ping' }))
            }
          }, RELAY_PING_INTERVAL_MS)
          // Resetting backoff immediately would defeat it when the relay
          // closes the socket right after the handshake.
          backoffResetTimer = setTimeout(() => {
            backoffResetTimer = null
            reconnectAttempt.current = 0
          }, RELAY_BACKOFF_RESET_MS)
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
                // Updates were lost server-side; recover derived state from a
                // fresh snapshot, but keep the offline cache so the UI does
                // not go blank if the app restarts before it arrives. The
                // cursor is left to the normal flush so retained updates are
                // still processed.
                useSessionStore.getState().reset({ preserveCache: true })
                if (relay._getSessionCrypto()) {
                  void requestSnapshot()
                } else {
                  snapshotAfterCrypto.current = true
                }
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
      appStateSubscription.remove()
      clearSocketTimers()
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

  // Once the session is usable (encrypted), register this device's push token
  // with the relay so it can alert us when an agent needs attention while the
  // app is disconnected. Fire-and-forget: registerPushToken never throws and
  // dedupes re-registration internally.
  useEffect(() => {
    if (!isEncrypted || !sessionId || !deviceId) return
    const relay = useRelayStore.getState()
    const clientToken = relay._getClientToken()
    if (!clientToken) return
    void registerPushToken(relay.relayUrl, sessionId, deviceId, clientToken)
  }, [deviceId, isEncrypted, sessionId])
}
