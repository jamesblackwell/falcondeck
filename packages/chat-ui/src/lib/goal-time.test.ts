import { describe, expect, it } from 'vitest'

import { formatGoalElapsed } from './goal-time'

describe('formatGoalElapsed', () => {
  it('is null without a stamped start', () => {
    expect(formatGoalElapsed(null)).toBeNull()
    expect(formatGoalElapsed(undefined)).toBeNull()
  })

  it('is null for an unparseable stamp', () => {
    expect(formatGoalElapsed('not-a-date')).toBeNull()
  })

  it('formats under a minute as seconds', () => {
    const now = Date.parse('2026-08-19T00:01:00Z')
    expect(formatGoalElapsed('2026-08-19T00:00:42Z', now)).toBe('18s')
  })

  it('zero-pads seconds within minutes and minutes within hours', () => {
    const now = Date.parse('2026-08-19T01:07:05Z')
    expect(formatGoalElapsed('2026-08-19T00:00:00Z', now)).toBe('1h 07m')
    expect(formatGoalElapsed('2026-08-19T01:05:00Z', now)).toBe('2m 05s')
  })

  it('never shows negative time', () => {
    const now = Date.parse('2026-08-19T00:00:00Z')
    expect(formatGoalElapsed('2026-08-19T00:01:00Z', now)).toBe('0s')
  })
})
