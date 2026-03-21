import { describe, expect, it, vi } from 'vitest'

import { formatRelative, isMobileDeviceLabel, statusLabel, statusVariant } from './settings-utils'

describe('settings utils', () => {
  it('maps remote device states to badge variants', () => {
    expect(statusVariant('connected')).toBe('success')
    expect(statusVariant('offline')).toBe('warning')
    expect(statusVariant('revoked')).toBe('danger')
  })

  it('returns user-friendly status copy', () => {
    expect(statusLabel('pairing_pending')).toBe('Waiting for device')
    expect(statusLabel('device_trusted')).toBe('Trusted')
  })

  it('detects handheld device labels', () => {
    expect(isMobileDeviceLabel('My iPhone')).toBe(true)
    expect(isMobileDeviceLabel('Work MacBook')).toBe(false)
  })

  it('formats nearby timestamps relatively', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-21T12:00:00Z'))

    expect(formatRelative('2026-03-21T11:59:00Z')).toBe('1 minute ago')

    vi.useRealTimers()
  })
})
