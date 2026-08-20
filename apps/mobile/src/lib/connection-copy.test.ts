import { describe, expect, it } from 'vitest'

import { isRelayTransportError, RELAY_TRANSPORT_ERRORS } from './connection-copy'

describe('isRelayTransportError', () => {
  it('recognizes the relay socket dropping', () => {
    expect(isRelayTransportError(new Error(RELAY_TRANSPORT_ERRORS.dropped))).toBe(true)
    expect(isRelayTransportError(RELAY_TRANSPORT_ERRORS.closed)).toBe(true)
    expect(isRelayTransportError(RELAY_TRANSPORT_ERRORS.notReady)).toBe(true)
    expect(isRelayTransportError(new Error('Could not reach the relay'))).toBe(true)
    expect(
      isRelayTransportError(
        new Error('Request timed out — check your connection and try again'),
      ),
    ).toBe(true)
  })

  it('leaves real action failures alone', () => {
    expect(isRelayTransportError(new Error('Failed to send message'))).toBe(false)
    expect(isRelayTransportError(new Error('Desktop is connected, but sync is not ready yet.'))).toBe(
      false,
    )
  })
})
