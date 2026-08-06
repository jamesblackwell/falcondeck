import * as Popover from '@radix-ui/react-popover'
import { Pause, Play, Target, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { AgentProvider, ThreadGoal } from '@falcondeck/client-core'
import { Button, Input, Textarea, cn } from '@falcondeck/ui'

const GOAL_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  blocked: 'Blocked',
  usageLimited: 'Usage limited',
  budgetLimited: 'Budget limited',
  complete: 'Complete',
}

function formatTokens(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

export type GoalControlProps = {
  goal: ThreadGoal | null
  provider: AgentProvider
  disabled?: boolean
  onSetGoal: (objective: string, tokenBudget: number | null) => Promise<void> | void
  onClearGoal: () => Promise<void> | void
  onSetGoalStatus?: (status: 'active' | 'paused') => Promise<void> | void
}

/**
 * Header control for the thread goal: shows the active objective and its
 * status, and hosts the set/clear flow. Token budgets and pause/resume are
 * Codex-only; Claude goals ride the `/goal` slash command.
 */
export function GoalControl({
  goal,
  provider,
  disabled = false,
  onSetGoal,
  onClearGoal,
  onSetGoalStatus,
}: GoalControlProps) {
  const [open, setOpen] = useState(false)
  const [objective, setObjective] = useState('')
  const [budget, setBudget] = useState('')
  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setObjective('')
      setBudget('')
      setError(null)
    }
  }, [open])

  const supportsBudget = provider === 'codex'
  const statusLabel = goal ? GOAL_STATUS_LABELS[goal.status] ?? goal.status : null

  async function run(action: () => Promise<void> | void) {
    setIsPending(true)
    setError(null)
    try {
      await action()
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Goal update failed')
    } finally {
      setIsPending(false)
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant={goal ? 'secondary' : 'ghost'}
          size="sm"
          disabled={disabled}
          className={cn('gap-1.5', !goal && 'text-fg-muted')}
          aria-label={goal ? `Goal: ${goal.objective}` : 'Set a goal'}
        >
          <Target className="h-4 w-4" aria-hidden />
          {goal ? (
            <span className="max-w-40 truncate text-[length:var(--fd-text-sm)]">
              {goal.objective}
            </span>
          ) : null}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 w-80 rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-1 p-4 shadow-[var(--fd-shadow-lg)]"
        >
          {goal ? (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                  {goal.objective}
                </p>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-[length:var(--fd-text-2xs)] uppercase tracking-[0.08em]',
                    goal.status === 'complete'
                      ? 'bg-success/15 text-success'
                      : goal.status === 'active'
                        ? 'bg-accent-dim text-accent'
                        : 'bg-surface-3 text-fg-secondary',
                  )}
                >
                  {statusLabel}
                </span>
              </div>
              {goal.token_budget != null || goal.tokens_used != null ? (
                <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
                  {goal.tokens_used != null ? `${formatTokens(goal.tokens_used)} tokens used` : null}
                  {goal.tokens_used != null && goal.token_budget != null ? ' of ' : null}
                  {goal.token_budget != null ? `${formatTokens(goal.token_budget)} budget` : null}
                </p>
              ) : null}
              {error ? (
                <p className="text-[length:var(--fd-text-xs)] text-danger">{error}</p>
              ) : null}
              <div className="flex justify-end gap-2">
                {onSetGoalStatus && provider === 'codex' && goal.status !== 'complete' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isPending}
                    onClick={() =>
                      void run(() =>
                        onSetGoalStatus(goal.status === 'paused' ? 'active' : 'paused'),
                      )
                    }
                  >
                    {goal.status === 'paused' ? (
                      <>
                        <Play className="h-3.5 w-3.5" aria-hidden /> Resume
                      </>
                    ) : (
                      <>
                        <Pause className="h-3.5 w-3.5" aria-hidden /> Pause
                      </>
                    )}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isPending}
                  className="text-danger"
                  onClick={() => void run(() => onClearGoal())}
                >
                  <X className="h-3.5 w-3.5" aria-hidden /> Clear goal
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                const trimmed = objective.trim()
                if (!trimmed) return
                const parsedBudget = Number.parseInt(budget, 10)
                void run(() =>
                  onSetGoal(
                    trimmed,
                    supportsBudget && Number.isFinite(parsedBudget) && parsedBudget > 0
                      ? parsedBudget
                      : null,
                  ),
                )
              }}
            >
              <div className="space-y-1">
                <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                  Set a goal
                </p>
                <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
                  The agent keeps working turns until the objective is met.
                </p>
              </div>
              <Textarea
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                placeholder="e.g. All tests pass and lint is clean"
                rows={3}
                autoFocus
                disabled={isPending}
              />
              {supportsBudget ? (
                <Input
                  value={budget}
                  onChange={(event) => setBudget(event.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="Token budget (optional)"
                  inputMode="numeric"
                  disabled={isPending}
                  aria-label="Token budget"
                />
              ) : null}
              {error ? (
                <p className="text-[length:var(--fd-text-xs)] text-danger">{error}</p>
              ) : null}
              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={isPending || !objective.trim()}>
                  {isPending ? 'Setting…' : 'Set goal'}
                </Button>
              </div>
            </form>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
