import { useMemo } from 'react'
import { isDaemonRpcReady } from '@falcondeck/client-core'

import { useRelayStore } from '@/store'
import { resolveSessionSyncStatus, type SessionSyncStatus } from '@/lib/session-status'

/**
 * The one place the UI asks "is this session usable yet?". Backed by the relay
 * connection state plus whether the first snapshot has landed, so the sidebar
 * and the composer never disagree about what the app is waiting for.
 */
export function useSessionSyncStatus(): SessionSyncStatus {
  const connectionStatus = useRelayStore((s) => s.connectionStatus)
  const isEncrypted = useRelayStore((s) => s.isEncrypted)
  const isSyncing = useRelayStore((s) => s.isSyncing)
  const hasSyncedOnce = useRelayStore((s) => s.hasSyncedOnce)
  const machinePresence = useRelayStore((s) => s.machinePresence)
  const syncDiagnostics = useRelayStore((s) => s.syncDiagnostics)
  const daemonConnected = machinePresence?.daemon_connected ?? false
  const daemonPresenceKnown = machinePresence !== null
  // Older relays omit readiness. Preserve their transport-only behaviour
  // until the relay upgrade reaches the device.
  const daemonRpcReady = isDaemonRpcReady(machinePresence)

  // Memoised so the banner's memo() actually holds: the resolver returns a
  // fresh object every call and this hook runs on every parent render.
  return useMemo(
    () =>
      resolveSessionSyncStatus({
        connectionStatus,
        isEncrypted,
        isSyncing,
        daemonConnected,
        daemonPresenceKnown,
        daemonRpcReady,
        hasSyncedOnce,
        syncStartedAt: syncDiagnostics.startedAt,
        syncAttempt: syncDiagnostics.attempt,
        nextRetryAt: syncDiagnostics.nextRetryAt,
        lastError: syncDiagnostics.lastError,
      }),
    [
      connectionStatus,
      daemonConnected,
      daemonPresenceKnown,
      daemonRpcReady,
      hasSyncedOnce,
      isEncrypted,
      isSyncing,
      syncDiagnostics,
    ],
  )
}
