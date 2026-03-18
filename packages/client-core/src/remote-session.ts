export type PersistedRemoteSession = {
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

  const queryRelayUrl = params.get('relay')
  const queryPairingCode = params.get('code')

  if (queryPairingCode && queryPairingCode !== persistedSession.pairingCode) {
    return null
  }

  if (queryRelayUrl && queryRelayUrl !== persistedSession.relayUrl) {
    return null
  }

  return persistedSession
}
