import { describe, expect, it, vi } from 'vitest'

import {
  formatRelative,
  isMobileDeviceLabel,
  searchSettings,
  statusLabel,
  statusVariant,
} from './settings-utils'

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

describe('searchSettings', () => {
  const ids = (query: string) => searchSettings(query).map((result) => result.item.id)

  it('matches word prefixes, not substrings inside words', () => {
    expect(ids('clean up')).toEqual(['speech'])
    expect(ids('up')).not.toContain('backup')
  })

  it('lists the matching setting titles under their page', () => {
    expect(searchSettings('failed')).toContainEqual(
      expect.objectContaining({ matches: ['Failed turns'] }),
    )
  })

  it('finds the OpenRouter key from both pages that need it', () => {
    expect(ids('openrouter')).toEqual(['speech', 'models'])
  })

  it('treats regex characters literally and returns nothing for blank queries', () => {
    expect(ids('(')).toEqual([])
    expect(ids('   ')).toEqual([])
  })
})
