/**
 * Activates demo mode by populating the session and relay stores
 * with realistic mock data. Used for App Store review.
 */
import { useRelayStore } from '@/store/relay-store'
import { useSessionStore } from '@/store/session-store'
import { DEMO_SESSION_ID, demoSnapshot, demoThreadItems } from './demoData'

export function enterDemoMode() {
  // Set relay store to appear connected and encrypted
  useRelayStore.setState({
    sessionId: DEMO_SESSION_ID,
    deviceId: 'demo-device',
    connectionStatus: 'encrypted',
    isConnected: true,
    isEncrypted: true,
    isSyncing: false,
    hasSyncedOnce: true,
    machinePresence: {
      session_id: DEMO_SESSION_ID,
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

  // Seed every thread so the sidebar never opens onto an empty conversation —
  // demo mode has no daemon to fetch a transcript from.
  session.selectThread('demo-workspace', 'demo-thread-1')
  for (const thread of demoSnapshot.threads) {
    const items = demoThreadItems[thread.id]
    if (!items) continue
    session.setThreadDetail({
      workspace: demoSnapshot.workspaces[0]!,
      thread,
      items,
      has_older: false,
      oldest_item_id: items[0]?.id ?? null,
      newest_item_id: items.at(-1)?.id ?? null,
      is_partial: false,
    })
  }
}
