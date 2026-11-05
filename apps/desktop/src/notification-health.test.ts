import { describe, expect, it } from 'vitest'
import type { TrustedDevice } from '@falcondeck/client-core'

import {
  describeAttention,
  describeDesktop,
  describeDesktopTest,
  describeDevicePush,
  describeTestResult,
} from './notification-health'

const device = (push: TrustedDevice['push']): TrustedDevice => ({
  device_id: 'd',
  session_id: 's',
  label: 'iPhone',
  status: 'active',
  created_at: '2026-11-04T00:00:00Z',
  last_seen_at: null,
  revoked_at: null,
  push,
})

const counter = {
  kind: 'approval',
  delivered: 0,
  held: 0,
  settled: 0,
  expired: 0,
  evicted: 0,
  lost: 0,
  suppressed_desktop_active: 0,
  suppressed_preferences: 0,
  last_at: null,
}

describe('notification health copy', () => {
  it('tells an old relay apart from a device with no registration', () => {
    expect(describeDevicePush(device(undefined))).toContain('relay needs an update')
    expect(describeDevicePush(device({ provider: null }))).toContain('Not registered')
  })

  it('names the provider and failure reason', () => {
    const text = describeDevicePush(
      device({
        provider: 'apns',
        last_delivery: {
          at: '2026-11-04T10:00:00Z',
          kind: 'review',
          provider: 'apns',
          outcome: 'rejected',
          detail: 'APNs 400 BadDeviceToken',
        },
      }),
    )
    expect(text).toContain('Apple Push')
    expect(text).toContain('Reviews')
    expect(text).toContain('APNs 400 BadDeviceToken')
  })

  it('reports each test result', () => {
    expect(
      describeTestResult({ device_id: 'd', label: 'iPhone', provider: null, outcome: null }),
    ).toBe('iPhone: not registered, nothing sent.')
    expect(
      describeTestResult({ device_id: 'd', label: null, provider: 'apns', outcome: 'accepted' }),
    ).toBe('Paired device: accepted by Apple Push.')
  })

  it('says when macOS is the problem', () => {
    expect(describeDesktop('denied', null)).toContain('System Settings')
    expect(
      describeDesktop('granted', { at: '2026-11-04T10:00:00Z', outcome: 'failed' }),
    ).toContain('Last alert failed')
  })

  it('separates a blocked Mac from one that never registered', () => {
    expect(describeDesktopTest(true, 'granted')).toBe('This Mac: posted.')
    expect(describeDesktopTest(false, 'denied')).toContain('System Settings')
    expect(describeDesktopTest(false, 'default')).toContain('did not record an answer')
  })

  it('leaves out reasons that did not happen', () => {
    expect(
      describeAttention([
        {
          ...counter,
          delivered: 2,
          suppressed_desktop_active: 3,
        },
      ]),
    ).toEqual(['Approvals: 2 delivered, 3 not sent because you were at the Mac.'])
  })

  it('reads an older daemon, which reports sent', () => {
    expect(
      describeAttention([
        { kind: 'approval', sent: 2, suppressed_desktop_active: 0, suppressed_preferences: 0, last_at: null },
        { kind: 'review', suppressed_desktop_active: 0, suppressed_preferences: 0, last_at: null },
      ]),
    ).toEqual(['Approvals: 2 delivered.', 'Reviews: 0 delivered.'])
  })

  it('names every way a push can end, and what is still waiting', () => {
    expect(
      describeAttention([
        { ...counter, delivered: 1, held: 2, settled: 3, expired: 4, evicted: 5, lost: 6 },
      ]),
    ).toEqual([
      'Approvals: 1 delivered, 2 waiting for the relay, 3 answered or read before they could go, 4 expired after an hour waiting, 5 dropped for newer ones, 6 lost with no phone paired.',
    ])
  })
})
