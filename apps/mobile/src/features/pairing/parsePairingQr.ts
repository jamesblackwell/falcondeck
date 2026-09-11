import {
  DEFAULT_REMOTE_RELAY_URL,
  PAIRING_APP_SCHEME,
  normalizePairingCodeInput,
  tryNormalizeRelayUrl,
} from '@falcondeck/client-core'

export type ParsedPairingQr = {
  relayUrl: string
  pairingCode: string
  requiresRelayConfirmation: boolean
}

function normalizePairingCode(value: string) {
  return normalizePairingCodeInput(value.trim())
}

function firstParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0]
  return value
}

/** Rebuild a pairing payload from expo-router search params. */
export function pairingPayloadFromSearchParams(params: {
  code?: string | string[]
  relay?: string | string[]
}): string | null {
  const code = firstParam(params.code)?.trim()
  if (!code) return null
  const url = new URL(`${PAIRING_APP_SCHEME}://pair`)
  url.searchParams.set('code', code)
  const relay = firstParam(params.relay)?.trim()
  if (relay) url.searchParams.set('relay', relay)
  return url.toString()
}

function parseSearchParams(searchParams: URLSearchParams): ParsedPairingQr | null {
  const code = normalizePairingCode(searchParams.get('code') ?? '')
  if (!code) {
    return null
  }

  const relayUrlParam = searchParams.get('relay')?.trim()
  const relayUrl = relayUrlParam ? tryNormalizeRelayUrl(relayUrlParam) : DEFAULT_REMOTE_RELAY_URL
  if (!relayUrl) {
    return null
  }

  return {
    relayUrl,
    pairingCode: code,
    requiresRelayConfirmation: relayUrl !== DEFAULT_REMOTE_RELAY_URL,
  }
}

function parseFromUrl(value: string) {
  try {
    return parseSearchParams(new URL(value).searchParams)
  } catch {
    // Some URL implementations reject custom schemes. Parse the query only.
    const queryIndex = value.indexOf('?')
    if (queryIndex < 0) return null
    return parseSearchParams(new URLSearchParams(value.slice(queryIndex + 1)))
  }
}

export function parsePairingQr(value: string): ParsedPairingQr | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  const parsedUrl = parseFromUrl(trimmed)
  if (parsedUrl) {
    return parsedUrl
  }

  if (/^[A-Z0-9._-]{4,}$/i.test(trimmed)) {
    return {
      relayUrl: DEFAULT_REMOTE_RELAY_URL,
      pairingCode: normalizePairingCode(trimmed),
      requiresRelayConfirmation: false,
    }
  }

  return null
}
