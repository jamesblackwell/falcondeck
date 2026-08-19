import * as Popover from '@radix-ui/react-popover'
import { Target } from 'lucide-react'
import { useState } from 'react'

import type { AgentProvider, ThreadGoal } from '@falcondeck/client-core'
import { cn } from '@falcondeck/ui'

import { useGoalElapsedLabel } from '../lib/goal-time'
import { GOAL_STATUS_LABELS, GoalPanel } from './goal-control'

export type GoalBubbleProps = {
  goal: ThreadGoal
  provider: AgentProvider
  onClearGoal: () => Promise<void> | void
  onSetGoalStatus?: (status: 'active' | 'paused') => Promise<void> | void
}

/**
 * A small centered pill above the composer while a goal is active: just the
 * word "Goal" and how long it has been running. Tapping opens the objective
 * with its status and the stop action — the compact sibling of the queued
 * messages card.
 */
export function GoalBubble({ goal, provider, onClearGoal, onSetGoalStatus }: GoalBubbleProps) {
  const [open, setOpen] = useState(false)
  const elapsed = useGoalElapsedLabel(goal.started_at)
  const statusLabel = GOAL_STATUS_LABELS[goal.status] ?? goal.status

  return (
    // Mirror the composer wrapper and its padding so the bubble centers on
    // the prompt card's column, at every responsive breakpoint.
    <div className="mx-auto mb-2 w-full max-w-3xl px-3 md:px-6">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="fd-focus mx-auto flex items-center gap-1.5 rounded-full border border-border-default bg-surface-2 py-1 pl-2.5 pr-3 shadow-[var(--fd-shadow-sm)] transition-colors hover:bg-surface-3"
            aria-label={`Goal: ${goal.objective}${elapsed ? `, running for ${elapsed}` : ''}. ${statusLabel}.`}
          >
            <Target
              className={cn(
                'h-3.5 w-3.5',
                goal.status === 'active'
                  ? 'text-accent'
                  : goal.status === 'complete'
                    ? 'text-success'
                    : 'text-fg-muted',
              )}
              aria-hidden
            />
            <span className="text-[length:var(--fd-text-xs)] font-medium text-fg-secondary">
              Goal
            </span>
            {elapsed ? (
              <span className="font-mono text-[length:var(--fd-text-xs)] text-fg-muted">
                {elapsed}
              </span>
            ) : (
              <span className="text-[length:var(--fd-text-xs)] text-fg-muted">{statusLabel}</span>
            )}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="center"
            side="top"
            sideOffset={8}
            className="z-50 w-80 rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-1 p-4 shadow-[var(--fd-shadow-lg)]"
          >
            {open ? (
              <GoalPanel
                goal={goal}
                provider={provider}
                onDone={() => setOpen(false)}
                onClearGoal={onClearGoal}
                onSetGoalStatus={onSetGoalStatus}
              />
            ) : null}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}
