import { useMemo } from 'react'

import { useRelayStore, useSessionStore } from '@/store'
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
  const daemonConnected = useRelayStore((s) => s.machinePresence?.daemon_connected ?? false)
  const hasSnapshot = useSessionStore((s) => s.snapshot !== null)

  // Memoised so the banner's memo() actually holds: the resolver returns a
  // fresh object every call and this hook runs on every parent render.
  return useMemo(
    () =>
      resolveSessionSyncStatus({
        connectionStatus,
        isEncrypted,
        isSyncing,
        hasSnapshot,
        daemonConnected,
        hasSyncedOnce,
      }),
    [connectionStatus, daemonConnected, hasSnapshot, hasSyncedOnce, isEncrypted, isSyncing],
  )
}
