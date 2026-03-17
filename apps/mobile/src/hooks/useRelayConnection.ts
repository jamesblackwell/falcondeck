import { useEffect, useRef, useCallback } from 'react'

import type { RelayServerMessage, RelayUpdate, EventEnvelope } from '@falcondeck/client-core'

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
  const connectionStatus = useRelayStore((s) => s.connectionStatus)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttempt = useRef(0)
  const pendingEncrypted = useRef<RelayUpdate[]>([])

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

    const relayUrl = relay.relayUrl.trim().replace(/\/$/, '')
    const wsUrl = relayUrl.startsWith('https://')
      ? `wss://${relayUrl.slice('https://'.length)}`
      : relayUrl.startsWith('http://')
        ? `ws://${relayUrl.slice('http://'.length)}`
        : relayUrl

    const socket = new WebSocket(
      `${wsUrl}/v1/updates/ws?session_id=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(clientToken)}`,
    )

    relay._setSocket(socket)
    relay._setConnectionStatus('connecting')
    relay._setError(null)
    pendingEncrypted.current = []

    socket.onopen = () => {
      reconnectAttempt.current = 0
      relay._setConnectionStatus('connected')
      relay._sendMessage({ type: 'sync', after_seq: relay._getLastReceivedSeq() })
    }

    socket.onmessage = (msg) => {
      const payload = JSON.parse(msg.data) as RelayServerMessage
      switch (payload.type) {
        case 'ready':
          if (relay._getSessionCrypto()) {
            relay._setConnectionStatus('encrypted')
          }
          break
        case 'sync':
          for (const u of payload.updates) void processUpdate(u)
          break
        case 'update':
          void processUpdate(payload.update)
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
      relay._setConnectionStatus('disconnected')
      relay._setSocket(null)
      pendingEncrypted.current = []

      // Exponential backoff reconnect
      const delay = Math.min(1000 * 2 ** reconnectAttempt.current, 15_000)
      reconnectAttempt.current += 1
      reconnectTimer.current = setTimeout(() => {
        // Trigger re-render to reconnect
        useRelayStore.setState((s) => ({ ...s }))
      }, delay)
    }

    return () => {
      socket.close()
      relay._setSocket(null)
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
        reconnectTimer.current = null
      }
    }
  }, [sessionId, connectionStatus === 'disconnected' ? Date.now() : 0, processUpdate])
}
