import { DEFAULT_REMOTE_RELAY_URL } from '@falcondeck/client-core'

export type ParsedPairingQr = {
  relayUrl: string
  pairingCode: string
}

function normalizeRelayUrl(value: string) {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function normalizePairingCode(value: string) {
  return value.trim().toUpperCase()
}

function parseFromUrl(value: string) {
  try {
    const url = new URL(value)
    const code = normalizePairingCode(url.searchParams.get('code') ?? '')

    if (!code) {
      return null
    }

    const relayUrlParam = url.searchParams.get('relay')?.trim()
    const relayUrl = relayUrlParam ? normalizeRelayUrl(relayUrlParam) : DEFAULT_REMOTE_RELAY_URL
    if (!relayUrl) {
      return null
    }

    return {
      relayUrl,
      pairingCode: code,
    } satisfies ParsedPairingQr
  } catch {
    return null
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

  if (/^[A-Z0-9-]{4,}$/i.test(trimmed)) {
    return {
      relayUrl: DEFAULT_REMOTE_RELAY_URL,
      pairingCode: normalizePairingCode(trimmed),
    }
  }

  return null
}
