export const DEFAULT_REMOTE_RELAY_URL = 'https://connect.falcondeck.com'
export const REMOTE_SESSION_STORAGE_VERSION = 2

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
