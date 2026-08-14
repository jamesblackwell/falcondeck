import type { ConversationItem, ThreadPlan, ThreadPlanStep } from './types'

export type PlanStepState =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'unknown'

export type PlanStepPresentation = {
  state: PlanStepState
  label: string
}

export function planStepPresentation(status: string): PlanStepPresentation {
  const normalized = status.trim().toLowerCase().replace(/[-\s]+/g, '_')
  if (['completed', 'complete', 'done', 'succeeded', 'success'].includes(normalized)) {
    return { state: 'completed', label: 'Completed' }
  }
  if (['in_progress', 'running', 'active', 'started'].includes(normalized)) {
    return { state: 'in_progress', label: 'In progress' }
  }
  if (['pending', 'queued', 'not_started', 'todo'].includes(normalized)) {
    return { state: 'pending', label: 'Pending' }
  }
  if (normalized === 'blocked') {
    return { state: 'blocked', label: 'Blocked' }
  }
  if (['failed', 'error'].includes(normalized)) {
    return { state: 'failed', label: 'Failed' }
  }
  if (['cancelled', 'canceled'].includes(normalized)) {
    return { state: 'failed', label: 'Cancelled' }
  }
  const words = normalized.replace(/_/g, ' ')
  const label = words ? `${words[0].toUpperCase()}${words.slice(1)}` : 'Unknown status'
  return { state: 'unknown', label }
}

/** Resolve every step's presentation for a checklist, keeping only the most
 * recent in-progress step marked as running. Agents can start a step while
 * leaving an earlier one still marked in-progress, which would otherwise pulse
 * more than one activity diamond; the older one reads as completed instead. */
export function planStepPresentations(
  steps: readonly ThreadPlanStep[],
): PlanStepPresentation[] {
  let lastInProgress = -1
  for (let index = 0; index < steps.length; index += 1) {
    if (planStepPresentation(steps[index].status).state === 'in_progress') {
      lastInProgress = index
    }
  }
  return steps.map((step, index) => {
    const presentation = planStepPresentation(step.status)
    if (presentation.state === 'in_progress' && index !== lastInProgress) {
      return { state: 'completed', label: 'Completed' }
    }
    return presentation
  })
}

export type PinnedPlan = {
  /** Conversation item the plan came from, so the transcript can skip it. */
  itemId: string
  plan: ThreadPlan
}

/** The plan belonging to the newest turn, for pinning above the composer.
 *
 * Providers rewrite one plan item per turn, so the newest plan item with steps
 * is the live checklist — but only while no user message follows it. A plan
 * from three turns ago is history, and pinning it would claim the agent is
 * still working through steps it abandoned.
 */
export function currentTurnPlan(
  items: readonly ConversationItem[],
): PinnedPlan | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind === 'user_message') return null
    // Codex emits plan items carrying only an explanation; there is nothing to
    // track in a one-line bar, so those stay inline.
    if (item.kind === 'plan' && item.plan.steps.length > 0) {
      return { itemId: item.id, plan: item.plan }
    }
  }
  return null
}

export type PlanProgress = {
  completed: number
  total: number
  /** The step the collapsed bar names: the running one, else the next unfinished
   * one, else null once every step has finished. */
  current: ThreadPlanStep | null
}

export function planProgress(steps: readonly ThreadPlanStep[]): PlanProgress {
  let completed = 0
  let running: ThreadPlanStep | null = null
  let nextUnfinished: ThreadPlanStep | null = null
  for (const step of steps) {
    const { state } = planStepPresentation(step.status)
    if (state === 'completed') {
      completed += 1
      continue
    }
    if (state === 'in_progress') running = step
    if (!nextUnfinished) nextUnfinished = step
  }
  return { completed, total: steps.length, current: running ?? nextUnfinished }
}

/** Stable React keys for ordered plan updates. Provider IDs win; legacy steps
 * retain identity through status changes and reorder by text plus occurrence. */
export function planStepRenderKeys(steps: readonly ThreadPlanStep[]): string[] {
  const occurrences = new Map<string, number>()
  return steps.map((step) => {
    const providerId = step.id?.trim()
    const base = providerId ? `id:${providerId}` : `legacy:${step.step.trim() || 'step'}`
    const occurrence = occurrences.get(base) ?? 0
    occurrences.set(base, occurrence + 1)
    return `${base}:${occurrence}`
  })
}
