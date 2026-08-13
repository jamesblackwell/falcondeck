/**
 * Boot on a phone is not instant: the relay socket has to connect, the daemon
 * has to republish the session key, and only then can the snapshot RPC run.
 * Until all three finish, sending is disabled and the sidebar shows whatever
 * the offline cache held — which reads as "the app ignored my tap". This
 * resolves that window into one user-facing status so the UI can say what it
 * is waiting for instead of looking broken.
 */

export type SessionSyncStage =
  'pairing' | 'connecting' | 'securing' | 'syncing' | 'repairing' | 'offline' | 'ready'

export interface SessionSyncStatus {
  stage: SessionSyncStage
  /** Short headline, e.g. "Syncing your projects…" */
  label: string
  /** One line explaining what the user can do about it. */
  detail: string
  /** False once the session is usable — the banner hides. */
  isBusy: boolean
  syncStartedAt: number | null
  syncAttempt: number
  nextRetryAt: number | null
  lastError: string | null
}

export interface SessionSyncInput {
  connectionStatus: string
  isEncrypted: boolean
  /** A snapshot RPC is in flight. */
  isSyncing: boolean
  /** Any snapshot is loaded — including the stale offline cache. */
  hasSnapshot: boolean
  /** The paired desktop is reachable through the relay. */
  daemonConnected: boolean
  /** Presence has arrived from the relay. False avoids briefly reporting an
   * offline Mac between the socket-ready and presence frames. */
  daemonPresenceKnown?: boolean
  /** The connected daemon has registered snapshot.current. Undefined means
   * an older relay that only reports transport presence. */
  daemonRpcReady?: boolean
  /** First sync since launch has landed. */
  hasSyncedOnce: boolean
  syncStartedAt?: number | null
  syncAttempt?: number
  nextRetryAt?: number | null
  lastError?: string | null
}

export function resolveSessionSyncStatus(input: SessionSyncInput): SessionSyncStatus {
  const { connectionStatus, isEncrypted, isSyncing, hasSnapshot, daemonConnected, hasSyncedOnce } =
    input
  const diagnostics = {
    syncStartedAt: input.syncStartedAt ?? null,
    syncAttempt: input.syncAttempt ?? 0,
    nextRetryAt: input.nextRetryAt ?? null,
    lastError: input.lastError ?? null,
  }
  const busy = (
    stage: Exclude<SessionSyncStage, 'ready'>,
    label: string,
    detail: string,
  ): SessionSyncStatus => ({
    stage,
    label,
    detail,
    isBusy: true,
    ...diagnostics,
  })

  if (connectionStatus === 'claiming') {
    return busy('pairing', 'Pairing this device…', 'Finishing the handshake with your Mac.')
  }

  if (!isEncrypted) {
    // 'connected' means the socket is up but the session data key has not
    // arrived yet, which is its own (usually brief) wait.
    if (connectionStatus === 'connected') {
      return busy('securing', 'Securing session…', 'Exchanging encryption keys with your Mac.')
    }
    if (connectionStatus === 'connecting' || connectionStatus === 'disconnected') {
      return busy(
        'connecting',
        'Reconnecting…',
        hasSnapshot
          ? 'Showing your last synced projects until the connection is back.'
          : 'Waiting for the relay connection.',
      )
    }
    return busy('offline', 'Not connected', 'Pair this device from Settings to start a thread.')
  }

  if (input.daemonPresenceKnown === false) {
    return busy(
      'syncing',
      'Checking desktop…',
      'Waiting for your Mac\'s status from the relay.',
    )
  }

  if (!daemonConnected) {
    return busy(
      'offline',
      'Desktop offline',
      'FalconDeck is not running on your Mac, so new threads cannot start.',
    )
  }

  if (input.daemonRpcReady === false) {
    return busy(
      'repairing',
      'Repairing sync…',
      'Your Mac is online, but its sync service is re-registering. Retrying automatically.',
    )
  }

  if (isSyncing || !hasSyncedOnce) {
    return busy(
      'syncing',
      'Syncing your projects…',
      hasSnapshot
        ? 'Threads may be a few seconds out of date until this finishes.'
        : 'Loading projects and threads from your Mac.',
    )
  }

  return {
    stage: 'ready',
    label: 'Connected',
    detail: '',
    isBusy: false,
    ...diagnostics,
  }
}

/**
 * Why the composer's send button is dead, phrased for the person holding the
 * phone. Returns null when sending is only blocked for unrelated reasons.
 */
export function sessionSendBlockReason(status: SessionSyncStatus): string | null {
  switch (status.stage) {
    case 'pairing':
      return 'Pairing this device…'
    case 'connecting':
      return 'Reconnecting to your Mac…'
    case 'securing':
      return 'Securing session…'
    case 'syncing':
      return 'Syncing with your Mac…'
    case 'repairing':
      return 'Repairing sync with your Mac…'
    case 'offline':
      return 'Not connected to your Mac'
    case 'ready':
      return null
  }
}
