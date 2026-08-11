import type {
  ConversationItem,
  DaemonSnapshot,
} from './types'

export const DEFAULT_REMOTE_RELAY_URL = 'https://connect.falcondeck.com'
export const REMOTE_SESSION_STORAGE_VERSION = 2
export const MOBILE_SESSION_CACHE_VERSION = 1
/** Maximum number of queued relay updates before reconnecting from a safe cursor. */
export const MAX_PENDING_RELAY_UPDATES = 2_048

export function relayBacklogWouldOverflow(
  queuedUpdates: number,
  incomingUpdates: number,
  maxUpdates = MAX_PENDING_RELAY_UPDATES,
) {
  return queuedUpdates < 0 || incomingUpdates < 0 || queuedUpdates + incomingUpdates > maxUpdates
}

/**
 * Resolves the durable cursor for a truncated replay window that may contain
 * no retained updates. Parked encrypted updates must remain ahead of the
 * cursor until the session key is available and they have been consumed.
 */
export function resolveRelayTruncationCursor(
  truncationNextSeq: number | null,
  parkedUpdateCount: number,
): number | null {
  if (truncationNextSeq === null || parkedUpdateCount > 0) return null
  return Math.max(truncationNextSeq - 1, 0)
}

/**
 * Reconnect quickly after a transient drop, then back off when the relay is
 * genuinely unavailable. The first retry is deliberately short because the
 * common case is a brief Wi-Fi or foreground transition; the cap and jitter
 * prevent a fleet of clients from retrying in lockstep during an outage.
 */
export function relayReconnectDelayMs(
  attempt: number,
  random = Math.random(),
  maxDelayMs = 10_000,
) {
  const normalizedAttempt = Math.max(0, Math.floor(attempt))
  const baseDelayMs = normalizedAttempt === 0
    ? 250
    : Math.min(1_000 * 2 ** (normalizedAttempt - 1), maxDelayMs)
  const boundedRandom = Math.min(Math.max(random, 0), 1)
  return Math.min(maxDelayMs, Math.round(baseDelayMs * (0.8 + boundedRandom * 0.4)))
}

export type PersistedRemoteSession = {
  version: typeof REMOTE_SESSION_STORAGE_VERSION
  relayUrl: string
  pairingCode: string
  pairingId?: string | null
  sessionId: string
  deviceId?: string | null
  clientToken: string
  clientSecretKey: string
  daemonPublicKey?: string | null
  daemonIdentityPublicKey?: string | null
  dataKey?: string | null
  lastReceivedSeq?: number
}

export type CachedThreadHistory = {
  thread_id: string
  items: ConversationItem[]
  has_older: boolean
  oldest_item_id: string | null
  newest_item_id: string | null
  is_partial: boolean
  updated_at: string
}

export type MobileSessionCache = {
  version: typeof MOBILE_SESSION_CACHE_VERSION
  snapshot: DaemonSnapshot
  selectedWorkspaceId: string | null
  selectedThreadId: string | null
  recentThreadIds: string[]
  threadHistories: Record<string, CachedThreadHistory>
}

export function shouldReusePersistedRemoteSession(
  params: URLSearchParams,
  persistedSession: PersistedRemoteSession | null,
) {
  if (!persistedSession) return null
  if (persistedSession.version !== REMOTE_SESSION_STORAGE_VERSION) {
    return null
  }

  const queryRelayUrl = params.get('relay')
  const queryPairingCode = params.get('code')
  const effectiveQueryRelayUrl =
    queryPairingCode && !queryRelayUrl ? DEFAULT_REMOTE_RELAY_URL : queryRelayUrl

  if (queryPairingCode && queryPairingCode !== persistedSession.pairingCode) {
    return null
  }

  if (effectiveQueryRelayUrl && effectiveQueryRelayUrl !== persistedSession.relayUrl) {
    return null
  }

  return persistedSession
}
