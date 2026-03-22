/**
 * Activates demo mode by populating the session and relay stores
 * with realistic mock data. Used for App Store review.
 */
import { useRelayStore } from '@/store/relay-store'
import { useSessionStore } from '@/store/session-store'
import { demoSnapshot, demoConversationItems } from './demoData'

export function enterDemoMode() {
  // Set relay store to appear connected and encrypted
  useRelayStore.setState({
    sessionId: 'demo-session',
    deviceId: 'demo-device',
    connectionStatus: 'encrypted',
    isConnected: true,
    isEncrypted: true,
    machinePresence: {
      session_id: 'demo-session',
      daemon_connected: true,
      last_seen_at: new Date().toISOString(),
    },
    error: null,
  })

  // Load the demo snapshot into session store
  const session = useSessionStore.getState()
  session.applyDaemonEvent({
    seq: 1,
    emitted_at: new Date().toISOString(),
    workspace_id: null,
    thread_id: null,
    event: { type: 'snapshot', snapshot: demoSnapshot },
  })

  // Select the first thread and inject conversation items
  session.selectThread('demo-workspace', 'demo-thread-1')
  session.setThreadDetail({
    workspace: demoSnapshot.workspaces[0]!,
    thread: demoSnapshot.threads[0]!,
    items: demoConversationItems,
  })
}
