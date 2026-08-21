import { describe, expect, it } from 'vitest'

import { normalizeRelayUrl, tryNormalizeRelayUrl } from './relay-url'

describe('normalizeRelayUrl', () => {
  it('accepts HTTPS and loopback HTTP', () => {
    expect(normalizeRelayUrl(' https://connect.example/ ')).toBe('https://connect.example')
    expect(normalizeRelayUrl('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787')
    expect(normalizeRelayUrl('http://[::1]:8787/')).toBe('http://[::1]:8787')
  })

  it.each([
    'http://connect.example',
    'http://192.0.2.10:8787',
    'https://user:secret@connect.example',
    'https://connect.example?token=secret',
    'https://connect.example/#fragment',
    'not a URL',
  ])('rejects unsafe relay URL %s', (value) => {
    expect(() => normalizeRelayUrl(value)).toThrow()
    expect(tryNormalizeRelayUrl(value)).toBeNull()
  })
})
