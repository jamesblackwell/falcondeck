import { describe, expect, it } from 'vitest'

import { DEFAULT_REMOTE_RELAY_URL } from '@falcondeck/client-core'

import { parsePairingQr } from './parsePairingQr'

describe('parsePairingQr', () => {
  it('parses the desktop pairing link format', () => {
    expect(parsePairingQr('https://app.falcondeck.com/?code=abcd-1234.AbCd_-90')).toEqual({
      relayUrl: DEFAULT_REMOTE_RELAY_URL,
      pairingCode: 'ABCD-1234.AbCd_-90',
      requiresRelayConfirmation: false,
    })
  })

  it('parses a custom relay from the scanned link', () => {
    expect(
      parsePairingQr('https://app.falcondeck.com/?code=PAIR-9999&relay=https%3A%2F%2Frelay.test'),
    ).toEqual({
      relayUrl: 'https://relay.test',
      pairingCode: 'PAIR-9999',
      requiresRelayConfirmation: true,
    })
  })

  it('accepts a raw pairing code as a fallback', () => {
    expect(parsePairingQr('abcd1234')).toEqual({
      relayUrl: DEFAULT_REMOTE_RELAY_URL,
      pairingCode: 'ABCD1234',
      requiresRelayConfirmation: false,
    })
  })

  it('preserves the case-sensitive authority secret in a raw secure grant', () => {
    expect(parsePairingQr('abcd1234.AbCd_-90')).toEqual({
      relayUrl: DEFAULT_REMOTE_RELAY_URL,
      pairingCode: 'ABCD1234.AbCd_-90',
      requiresRelayConfirmation: false,
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

  it('rejects cleartext remote relays but permits loopback development', () => {
    expect(
      parsePairingQr('https://app.falcondeck.com/?code=PAIR-9999&relay=http%3A%2F%2Frelay.test'),
    ).toBeNull()
    expect(
      parsePairingQr('https://app.falcondeck.com/?code=PAIR-9999&relay=http%3A%2F%2F127.0.0.1%3A8787'),
    ).toEqual({
      relayUrl: 'http://127.0.0.1:8787',
      pairingCode: 'PAIR-9999',
      requiresRelayConfirmation: true,
    })
  })
})
