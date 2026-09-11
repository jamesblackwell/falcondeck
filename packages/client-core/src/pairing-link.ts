import { DEFAULT_REMOTE_RELAY_URL } from './remote-session'

export const DEFAULT_PAIRING_PAGE_ORIGIN = 'https://falcondeck.com'
export const PAIRING_APP_SCHEME = 'falcondeck'

export type PairingLinkParts = {
  pairingCode: string
  relayUrl: string
}

function pairingSearchParams(
  parts: PairingLinkParts,
  hostedRelayUrl = DEFAULT_REMOTE_RELAY_URL,
): URLSearchParams {
  const params = new URLSearchParams()
  params.set('code', parts.pairingCode)
  if (parts.relayUrl !== hostedRelayUrl) {
    params.set('relay', parts.relayUrl)
  }
  return params
}

/** HTTPS landing page used when a phone opens the link in a browser. */
export function buildPairingPageUrl(
  parts: PairingLinkParts,
  origin = DEFAULT_PAIRING_PAGE_ORIGIN,
): string {
  const base = origin.replace(/\/+$/, '')
  return `${base}/pair?${pairingSearchParams(parts).toString()}`
}

/** Custom-scheme URL that opens the FalconDeck iOS/Android app directly. */
export function buildPairingAppUrl(parts: PairingLinkParts): string {
  return `${PAIRING_APP_SCHEME}://pair?${pairingSearchParams(parts).toString()}`
}
