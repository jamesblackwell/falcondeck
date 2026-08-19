import { describe, expect, it } from 'vitest'

import type { ThreadGoal } from '@falcondeck/client-core'

import {
  formatGoalElapsed,
  formatTokens,
  goalCanPause,
  goalStatusLabel,
  goalStatusTone,
  goalSupportsBudget,
  goalUsageLine,
  parseTokenBudget,
} from './goal'

function goal(overrides: Partial<ThreadGoal> = {}): ThreadGoal {
  return { objective: 'All tests pass', status: 'active', ...overrides }
}

describe('goalStatusLabel', () => {
  it('labels every status the daemon documents', () => {
    expect(
      ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].map(
        goalStatusLabel,
      ),
    ).toEqual(['Active', 'Paused', 'Blocked', 'Usage limited', 'Budget limited', 'Complete'])
  })

  it('passes an unknown status through rather than blanking the pill', () => {
    expect(goalStatusLabel('somethingNew')).toBe('somethingNew')
  })
})

describe('goalStatusTone', () => {
  it('reserves success for a finished goal and accent for a live one', () => {
    expect(goalStatusTone('complete')).toBe('success')
    expect(goalStatusTone('active')).toBe('accent')
    expect(goalStatusTone('paused')).toBe('neutral')
    expect(goalStatusTone('blocked')).toBe('neutral')
  })
})

describe('formatTokens', () => {
  it('abbreviates at each threshold', () => {
    expect(formatTokens(840)).toBe('840')
    expect(formatTokens(1_000)).toBe('1k')
    expect(formatTokens(12_400)).toBe('12k')
    expect(formatTokens(1_200_000)).toBe('1.2M')
  })
})

describe('goalUsageLine', () => {
  it('is absent when the provider reports no usage', () => {
    expect(goalUsageLine(goal())).toBeNull()
  })

  it('reads as a fraction when there is a budget', () => {
    expect(goalUsageLine(goal({ tokens_used: 12_000, token_budget: 100_000 }))).toBe(
      '12k of 100k tokens',
    )
  })

  it('reads as usage alone when there is no budget', () => {
    expect(goalUsageLine(goal({ tokens_used: 900 }))).toBe('900 tokens used')
  })

  it('reads as a budget alone before any usage lands', () => {
    expect(goalUsageLine(goal({ token_budget: 50_000 }))).toBe('50k token budget')
  })

  it('treats an explicit null the same as an absent field', () => {
    expect(goalUsageLine(goal({ tokens_used: null, token_budget: null }))).toBeNull()
  })
})

describe('parseTokenBudget', () => {
  it('is null for an empty or non-numeric entry', () => {
    expect(parseTokenBudget('')).toBeNull()
    expect(parseTokenBudget('abc')).toBeNull()
  })

  it('strips separators the user typed', () => {
    expect(parseTokenBudget('100,000')).toBe(100000)
  })

  it('rejects zero, which the daemon would treat as an exhausted budget', () => {
    expect(parseTokenBudget('0')).toBeNull()
  })
})

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

describe('provider gating', () => {
  it('offers a budget and a pause only on Codex', () => {
    expect(goalSupportsBudget('codex')).toBe(true)
    expect(goalSupportsBudget('claude')).toBe(false)
    expect(goalCanPause(goal(), 'codex')).toBe(true)
    expect(goalCanPause(goal(), 'claude')).toBe(false)
  })

  it('does not offer to pause a finished goal', () => {
    expect(goalCanPause(goal({ status: 'complete' }), 'codex')).toBe(false)
  })
})
