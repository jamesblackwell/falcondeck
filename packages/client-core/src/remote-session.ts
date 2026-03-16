export type PersistedRemoteSession = {
  relayUrl: string
  pairingCode: string
  sessionId: string
  clientToken: string
  clientSecretKey: string
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
