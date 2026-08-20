/**
 * Boot on a phone is not instant: the relay socket has to connect, the daemon
 * has to republish the session key, and only then can the snapshot RPC run.
 * Until all three finish, sending is disabled and the sidebar shows whatever
 * the offline cache held — which reads as "the app ignored my tap". This
 * resolves that window into one user-facing status so the UI can say what it
 * is waiting for instead of looking broken.
 */

import { CONNECTION_COPY } from './connection-copy'

export type SessionSyncStage =
  | 'pairing'
  | 'connecting'
  | 'securing'
  | 'syncing'
  | 'repairing'
  | 'offline'
  | 'ready'

export interface SessionSyncStatus {
  stage: SessionSyncStage
  /** Short headline, e.g. "Syncing your projects…" */
  label: string
  /**
   * Second line, only when it adds something the label does not — what the
   * user can do, or what they are looking at meanwhile. Empty for the ordinary
   * waits, where restating the label just doubles the noise.
   */
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
   * offline desktop between the socket-ready and presence frames. */
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

export function resolveSessionSyncStatus(
  input: SessionSyncInput,
): SessionSyncStatus {
  const {
    connectionStatus,
    isEncrypted,
    isSyncing,
    hasSnapshot,
    daemonConnected,
    hasSyncedOnce,
  } = input
  const diagnostics = {
    syncStartedAt: input.syncStartedAt ?? null,
    syncAttempt: input.syncAttempt ?? 0,
    nextRetryAt: input.nextRetryAt ?? null,
    lastError: input.lastError ?? null,
  }
  const busy = (
    stage: Exclude<SessionSyncStage, 'ready'>,
    label: string,
    detail = '',
  ): SessionSyncStatus => ({
    stage,
    label,
    detail,
    isBusy: true,
    ...diagnostics,
  })

  if (connectionStatus === 'claiming') {
    return busy('pairing', CONNECTION_COPY.pairing)
  }

  if (!isEncrypted) {
    // 'connected' means the socket is up but the session data key has not
    // arrived yet, which is its own (usually brief) wait.
    if (connectionStatus === 'connected') {
      return busy('securing', CONNECTION_COPY.securing)
    }
    if (
      connectionStatus === 'connecting' ||
      connectionStatus === 'disconnected'
    ) {
      return busy(
        'connecting',
        // The phone connects to the relay. Desktop may be online while this
        // socket is down, especially on spotty cellular.
        CONNECTION_COPY.reconnecting,
        hasSnapshot ? CONNECTION_COPY.reconnectingStaleDetail : '',
      )
    }
    return busy(
      'offline',
      CONNECTION_COPY.notConnected,
      CONNECTION_COPY.notConnectedDetail,
    )
  }

  if (input.daemonPresenceKnown === false) {
    return busy('syncing', CONNECTION_COPY.checkingDesktop)
  }

  if (!daemonConnected) {
    return busy(
      'offline',
      CONNECTION_COPY.desktopOffline,
      CONNECTION_COPY.desktopOfflineDetail,
    )
  }

  if (input.daemonRpcReady === false) {
    return busy(
      'repairing',
      CONNECTION_COPY.repairing,
      CONNECTION_COPY.repairingDetail,
    )
  }

  if (isSyncing || !hasSyncedOnce) {
    return busy(
      'syncing',
      CONNECTION_COPY.syncing,
      hasSnapshot ? CONNECTION_COPY.syncingStaleDetail : '',
    )
  }

  return {
    stage: 'ready',
    label: CONNECTION_COPY.connected,
    detail: '',
    isBusy: false,
    ...diagnostics,
  }
}

/**
 * Why the composer's send button is dead, phrased for the person holding the
 * phone. Returns null when sending is only blocked for unrelated reasons.
 */
export function sessionSendBlockReason(
  status: SessionSyncStatus,
): string | null {
  switch (status.stage) {
    case 'ready':
      return null
    case 'pairing':
    case 'connecting':
    case 'securing':
    case 'syncing':
    case 'repairing':
    case 'offline':
      return status.label
  }
}

/**
 * The connection screen appears only after its own grace period, so it can
 * calmly explain any prolonged wait without flashing during ordinary 4G/Wi-Fi
 * flaps. Detailed transport history stays behind an explicit control there.
 */
export function shouldAutoShowConnectionDebug(
  status: SessionSyncStatus,
): boolean {
  return status.isBusy
}
