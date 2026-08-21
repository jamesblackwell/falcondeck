/**
 * Normalize a relay base URL and reject transports that expose bearer tokens
 * in cleartext. Plain HTTP remains available only for loopback development.
 */
export function normalizeRelayUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('Relay URL must be a valid absolute URL')
  }

  const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('Relay URL must use HTTPS (HTTP is allowed only for loopback development)')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Relay URL must not contain credentials, a query, or a fragment')
  }
  return url.toString().replace(/\/$/, '')
}

export function tryNormalizeRelayUrl(value: string): string | null {
  try {
    return normalizeRelayUrl(value)
  } catch {
    return null
  }
}
