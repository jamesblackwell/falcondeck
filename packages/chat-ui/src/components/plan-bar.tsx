import { ChevronDown } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { planProgress, planStepPresentation, type ThreadPlan } from '@falcondeck/client-core'
import { cn } from '@falcondeck/ui'

import { PlanStepIcon, PlanStepList } from './plan-steps'

/**
 * The current turn's plan, pinned directly above the composer.
 *
 * A plan scrolls out of view the moment the agent starts working, which is
 * exactly when it matters — so the live checklist lives here instead of in the
 * transcript. Collapsed it is one line: the running step and a step count;
 * expanded it is the full list. The transcript skips the same item (see
 * `Conversation`'s `pinnedPlanId`) so the plan never renders twice.
 */
export function PlanBar({
  plan,
  threadKey = null,
  defaultOpen = false,
}: {
  plan: ThreadPlan
  /** Collapses the bar again when the user switches threads. */
  threadKey?: string | null
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  useEffect(() => {
    setOpen(defaultOpen)
  }, [defaultOpen, threadKey])
  const progress = useMemo(() => planProgress(plan.steps), [plan.steps])

  if (plan.steps.length === 0) return null

  const { completed, total, current } = progress
  const currentState = current
    ? planStepPresentation(current.status).state
    : 'completed'
  const summary = current ? current.step : 'All steps complete'
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0

  return (
    // Same centered column as the transcript and composer, so the bar reads as
    // part of the composer stack rather than a floating overlay.
    <div className="mx-auto w-full max-w-3xl px-3 pb-2 md:px-6">
      <div className="overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={`Plan, ${completed} of ${total} steps complete`}
          className="fd-focus-inset flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-3"
        >
          <PlanStepIcon state={currentState} />
          <span className="fd-type-microlabel text-fg-muted">
            Plan
          </span>
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[length:var(--fd-text-sm)]',
              current ? 'text-fg-primary' : 'text-fg-muted',
            )}
          >
            {summary}
          </span>
          <span className="shrink-0 tabular-nums text-[length:var(--fd-text-xs)] text-fg-muted">
            {completed}/{total}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-fg-muted transition-transform',
              open && 'rotate-180',
            )}
          />
        </button>
        <div aria-hidden="true" className="h-px w-full bg-border-subtle">
          <div
            className="h-px bg-accent transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        {open ? (
          <div className="px-3 pb-2.5 pt-2">
            {plan.explanation ? (
              <p className="mb-2 text-[length:var(--fd-text-sm)] text-fg-secondary">
                {plan.explanation}
              </p>
            ) : null}
            <PlanStepList steps={plan.steps} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
