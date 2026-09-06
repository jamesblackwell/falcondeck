// Opt-in diagnostics for a dedicated simulator build. Never sends conversation content.
import { AppState, Platform } from 'react-native'
import { useRelayStore } from '@/store/relay-store'
import { useSessionStore } from '@/store/session-store'
import { useConnectionLogStore } from '@/store/connection-log-store'

export function installReliabilityProbe(endpoint: string) {
  // Restrict diagnostic export to the local lab controller.
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint) || Platform.OS !== 'ios') return
  const boot = `${Date.now()}`
  let events: Record<string, unknown>[] = []
  let inflight = false
  const emit = (event: string, fields: Record<string, unknown> = {}) => {
    events.push({ event, boot, at: performance.now(), ...fields })
    if (events.length > 500) events.shift()
  }
  const relay = useRelayStore.getState()
  const call = relay._callRpc
  const send = relay._sendMessage
  const handleResult = relay._handleRpcResult
  useRelayStore.setState({
    _sendMessage: message => {
      if (message.type === 'rpc-call') emit('rpc.sent', { request_id: message.request_id, method: message.method })
      send(message)
    },
    _handleRpcResult: async payload => {
      emit('rpc.received', { request_id: payload.request_id })
      const handled = await handleResult(payload)
      emit('rpc.applied', { request_id: payload.request_id, handled })
      return handled
    },
    _callRpc: async <T = unknown>(method: string, params: Record<string, unknown>, options?: { requestIdPrefix?: string; timeoutMs?: number }) => {
      const at = performance.now()
      emit('rpc.start', { method })
      try {
        const result = await call<T>(method, params, options)
        emit('rpc.end', { method, duration_ms: performance.now()-at, ok: true })
        return result
      } catch (error) {
        emit('rpc.end', { method, duration_ms: performance.now()-at, ok: false })
        throw error
      }
    },
  })
  const unsubscribeRelay = useRelayStore.subscribe(state => emit('relay.state', {
    status: state.connectionStatus, synced: state.hasSyncedOnce, syncing: state.isSyncing,
    desktop: state.machinePresence?.daemon_connected,
  }))
  const unsubscribeSession = useSessionStore.subscribe(state => emit('session.state', {
    workspaces: state.snapshot?.workspaces.length ?? 0,
    threads: state.snapshot?.threads.length ?? 0,
  }))
  const unsubscribeLog = useConnectionLogStore.subscribe(() => emit('connection.log.updated'))
  const appState = AppState.addEventListener('change', state => emit('app.state', { state }))
  let previous = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    emit('js.heartbeat', { delay_ms: Math.max(0, now-previous-1000), state: AppState.currentState })
    previous = now
    if (inflight || events.length === 0) return
    const batch = events
    events = []
    inflight = true
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 2000)
    void fetch(`${endpoint}/trace`, { method: 'POST', headers: { 'content-type':'application/json' },
      body: JSON.stringify(batch), signal: abort.signal,
    }).catch(() => {}).finally(() => { clearTimeout(timeout); inflight = false })
  }, 1000)
  emit('boot')
  return () => {
    clearInterval(timer)
    unsubscribeRelay(); unsubscribeSession(); unsubscribeLog(); appState.remove()
    useRelayStore.setState({ _callRpc: call, _sendMessage: send, _handleRpcResult: handleResult })
  }
}
