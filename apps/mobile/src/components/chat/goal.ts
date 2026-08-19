import { useEffect, useState } from 'react'

import type { ThreadGoal } from '@falcondeck/client-core'

/** Status names as the daemon spells them, labelled as desktop labels them. */
const GOAL_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  blocked: 'Blocked',
  usageLimited: 'Usage limited',
  budgetLimited: 'Budget limited',
  complete: 'Complete',
}

export type GoalStatusTone = 'success' | 'accent' | 'neutral'

export function goalStatusLabel(status: string): string {
  return GOAL_STATUS_LABELS[status] ?? status
}

export function goalStatusTone(status: string): GoalStatusTone {
  if (status === 'complete') return 'success'
  if (status === 'active') return 'accent'
  return 'neutral'
}

/** Compact token counts: 1.2M / 12k / 840. */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`
  return String(count)
}

/** The usage line under the objective, or null when the provider reports none. */
export function goalUsageLine(goal: ThreadGoal): string | null {
  const used = goal.tokens_used ?? null
  const budget = goal.token_budget ?? null
  if (used === null && budget === null) return null
  if (used !== null && budget !== null) {
    return `${formatTokens(used)} of ${formatTokens(budget)} tokens`
  }
  if (used !== null) return `${formatTokens(used)} tokens used`
  return `${formatTokens(budget!)} token budget`
}

/**
 * A budget only reaches the daemon when it is a positive whole number; the
 * field is optional, so anything else means "no budget" rather than an error.
 */
export function parseTokenBudget(raw: string): number | null {
  const digits = raw.replace(/[^0-9]/g, '')
  if (!digits) return null
  const parsed = Number.parseInt(digits, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** Only Codex accepts a token budget or a pause; Claude runs goals as slash
    commands and has neither. Desktop gates on the same literal. */
export function goalSupportsBudget(provider: string): boolean {
  return provider === 'codex'
}

export function goalCanPause(goal: ThreadGoal, provider: string): boolean {
  return goalSupportsBudget(provider) && goal.status !== 'complete'
}

/**
 * Elapsed wall-clock time since the goal started ("42s", "12m 05s",
 * "1h 07m"), or null when the daemon didn't stamp a start.
 */
export function formatGoalElapsed(
  startedAt: string | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (!startedAt) return null
  const startMs = Date.parse(startedAt)
  if (!Number.isFinite(startMs)) return null
  const totalSeconds = Math.max(0, Math.floor((nowMs - startMs) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

/** The elapsed label, re-rendered every second while the goal runs. */
export function useGoalElapsedLabel(startedAt: string | null | undefined): string | null {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!startedAt) return
    setNowMs(Date.now())
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  return formatGoalElapsed(startedAt, nowMs)
}
