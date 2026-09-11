import { describe, expect, it } from 'vitest'

import { DEFAULT_REMOTE_RELAY_URL } from './remote-session'
import {
  DEFAULT_PAIRING_PAGE_ORIGIN,
  buildPairingAppUrl,
  buildPairingPageUrl,
} from './pairing-link'

const hosted = {
  pairingCode: 'YMZEYPB2EZTA',
  relayUrl: DEFAULT_REMOTE_RELAY_URL,
}

describe('pairing links', () => {
  it('builds the mobile app URL for QR codes', () => {
    expect(buildPairingAppUrl(hosted)).toBe('falcondeck://pair?code=YMZEYPB2EZTA')
  })

  it('builds the HTTPS landing page for copied links and camera fallback', () => {
    expect(buildPairingPageUrl(hosted)).toBe(
      `${DEFAULT_PAIRING_PAGE_ORIGIN}/pair?code=YMZEYPB2EZTA`,
    )
  })

  it('includes a non-default relay on both URLs', () => {
    const parts = {
      pairingCode: 'PAIR-9999',
      relayUrl: 'https://relay.test',
    }
    expect(buildPairingAppUrl(parts)).toBe(
      'falcondeck://pair?code=PAIR-9999&relay=https%3A%2F%2Frelay.test',
    )
    expect(buildPairingPageUrl(parts)).toBe(
      'https://falcondeck.com/pair?code=PAIR-9999&relay=https%3A%2F%2Frelay.test',
    )
  })

  it('strips a trailing slash from a custom pairing origin', () => {
    expect(buildPairingPageUrl(hosted, 'https://pair.example.com/')).toBe(
      'https://pair.example.com/pair?code=YMZEYPB2EZTA',
    )
  })
})
