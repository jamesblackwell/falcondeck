/**
 * Boot on a phone is not instant: the relay socket has to connect, the daemon
 * has to republish the session key, and only then can the snapshot RPC run.
 * Until all three finish, sending is disabled and the sidebar shows whatever
 * the offline cache held — which reads as "the app ignored my tap". This
 * resolves that window into one user-facing status so the UI can say what it
 * is waiting for instead of looking broken.
 */

export type SessionSyncStage = 'pairing' | 'connecting' | 'securing' | 'syncing' | 'offline' | 'ready'

export interface SessionSyncStatus {
  stage: SessionSyncStage
  /** Short headline, e.g. "Syncing your projects…" */
  label: string
  /** One line explaining what the user can do about it. */
  detail: string
  /** False once the session is usable — the banner hides. */
  isBusy: boolean
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
  /** First sync since launch has landed. */
  hasSyncedOnce: boolean
}

export function resolveSessionSyncStatus(input: SessionSyncInput): SessionSyncStatus {
  const { connectionStatus, isEncrypted, isSyncing, hasSnapshot, daemonConnected, hasSyncedOnce } =
    input

  if (connectionStatus === 'claiming') {
    return {
      stage: 'pairing',
      label: 'Pairing this device…',
      detail: 'Finishing the handshake with your Mac.',
      isBusy: true,
    }
  }

  if (!isEncrypted) {
    // 'connected' means the socket is up but the session data key has not
    // arrived yet, which is its own (usually brief) wait.
    if (connectionStatus === 'connected') {
      return {
        stage: 'securing',
        label: 'Securing session…',
        detail: 'Exchanging encryption keys with your Mac.',
        isBusy: true,
      }
    }
    if (connectionStatus === 'connecting' || connectionStatus === 'disconnected') {
      return {
        stage: 'connecting',
        label: 'Reconnecting…',
        detail: hasSnapshot
          ? 'Showing your last synced projects until the connection is back.'
          : 'Waiting for the relay connection.',
        isBusy: true,
      }
    }
    return {
      stage: 'offline',
      label: 'Not connected',
      detail: 'Pair this device from Settings to start a thread.',
      isBusy: true,
    }
  }

  if (isSyncing || !hasSyncedOnce) {
    return {
      stage: 'syncing',
      label: 'Syncing your projects…',
      detail: hasSnapshot
        ? 'Threads may be a few seconds out of date until this finishes.'
        : 'Loading projects and threads from your Mac.',
      isBusy: true,
    }
  }

  if (!daemonConnected) {
    return {
      stage: 'offline',
      label: 'Desktop offline',
      detail: 'FalconDeck is not running on your Mac, so new threads cannot start.',
      isBusy: true,
    }
  }

  return { stage: 'ready', label: 'Connected', detail: '', isBusy: false }
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
    case 'offline':
      return 'Not connected to your Mac'
    case 'ready':
      return null
  }
}
