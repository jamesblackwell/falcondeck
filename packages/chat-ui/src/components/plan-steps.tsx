import { AlertTriangle, CheckCircle2, Circle, CircleX } from 'lucide-react'
import { useMemo } from 'react'

import {
  planStepPresentation,
  planStepRenderKeys,
  type PlanStepState,
  type ThreadPlanStep,
} from '@falcondeck/client-core'
import { ActivityDiamond, cn } from '@falcondeck/ui'

export function PlanStepIcon({ state }: { state: PlanStepState }) {
  switch (state) {
    case 'completed':
      return <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 text-success" />
    case 'in_progress':
      return <ActivityDiamond />
    case 'blocked':
      return <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 text-warning" />
    case 'failed':
      return <CircleX aria-hidden="true" className="h-3.5 w-3.5 text-danger" />
    default:
      return <Circle aria-hidden="true" className="h-3.5 w-3.5 text-fg-faint" />
  }
}

/** The plan checklist, shared by the transcript card and the pinned plan bar so
 * a step reads identically wherever it appears. */
export function PlanStepList({
  steps,
  className,
}: {
  steps: readonly ThreadPlanStep[]
  className?: string
}) {
  const stepKeys = useMemo(() => planStepRenderKeys(steps), [steps])
  return (
    <ol className={cn('space-y-1', className)}>
      {steps.map((step, index) => {
        const presentation = planStepPresentation(step.status)
        return (
          <li
            key={stepKeys[index]}
            aria-label={`${step.step}, ${presentation.label}`}
            className="flex items-start gap-2 py-0.5"
          >
            <PlanStepIcon state={presentation.state} />
            <span
              className={cn(
                'flex-1 text-[length:var(--fd-text-sm)] text-fg-primary',
                presentation.state === 'completed' && 'text-fg-muted line-through',
              )}
            >
              {step.step}
            </span>
            <span
              className={cn(
                'text-[length:var(--fd-text-2xs)] text-fg-muted',
                presentation.state === 'in_progress' && 'text-accent',
                presentation.state === 'blocked' && 'text-warning',
                presentation.state === 'failed' && 'text-danger',
              )}
            >
              {presentation.label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
