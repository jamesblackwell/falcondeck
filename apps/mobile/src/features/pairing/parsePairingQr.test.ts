import { describe, expect, it } from 'vitest'

import { DEFAULT_REMOTE_RELAY_URL } from '@falcondeck/client-core'

import { parsePairingQr } from './parsePairingQr'

describe('parsePairingQr', () => {
  it('parses the desktop pairing link format', () => {
    expect(parsePairingQr('https://app.falcondeck.com/?code=ABCD-1234')).toEqual({
      relayUrl: DEFAULT_REMOTE_RELAY_URL,
      pairingCode: 'ABCD-1234',
    })
  })

  it('parses a custom relay from the scanned link', () => {
    expect(
      parsePairingQr('https://app.falcondeck.com/?code=PAIR-9999&relay=https%3A%2F%2Frelay.test'),
    ).toEqual({
      relayUrl: 'https://relay.test',
      pairingCode: 'PAIR-9999',
    })
  })

  it('accepts a raw pairing code as a fallback', () => {
    expect(parsePairingQr('abcd1234')).toEqual({
      relayUrl: DEFAULT_REMOTE_RELAY_URL,
      pairingCode: 'ABCD1234',
    })
  })

  it('returns null for unrelated QR payloads', () => {
    expect(parsePairingQr('https://example.com/')).toBeNull()
  })

  it('rejects scanned links with unsupported relay protocols', () => {
    expect(
      parsePairingQr('https://app.falcondeck.com/?code=PAIR-9999&relay=ftp%3A%2F%2Frelay.test'),
    ).toBeNull()
  })
})
