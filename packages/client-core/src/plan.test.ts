import { describe, expect, it } from 'vitest'

import { upsertConversationItem } from './conversation'
import { currentTurnPlan, planProgress, planStepPresentation, planStepPresentations, planStepRenderKeys } from './plan'
import type { ConversationItem, ThreadPlanStep } from './types'

function userMessage(id: string): ConversationItem {
  return {
    kind: 'user_message',
    id,
    text: 'do the thing',
    attachments: [],
    created_at: '2026-08-09T12:00:00Z',
  }
}

function planItem(id: string, steps: ThreadPlanStep[]): ConversationItem {
  return {
    kind: 'plan',
    id,
    plan: { explanation: null, steps },
    created_at: '2026-08-09T12:00:00Z',
  }
}

describe('plan step presentation', () => {
  it.each([
    ['queued', 'pending', 'Pending'],
    ['running', 'in_progress', 'In progress'],
    ['done', 'completed', 'Completed'],
    ['blocked', 'blocked', 'Blocked'],
    ['failed', 'failed', 'Failed'],
    ['provider_future', 'unknown', 'Provider future'],
  ] as const)('normalizes %s without discarding its meaning', (status, state, label) => {
    expect(planStepPresentation(status)).toEqual({ state, label })
  })

  it('keeps provider IDs stable through text changes and reorder', () => {    const before = planStepRenderKeys([
      { id: 'one', step: 'Inspect', status: 'pending' },
      { id: 'two', step: 'Implement', status: 'pending' },
    ])
    const after = planStepRenderKeys([
      { id: 'two', step: 'Implement carefully', status: 'in_progress' },
      { id: 'one', step: 'Inspect', status: 'completed' },
    ])

    expect(after).toEqual([before[1], before[0]])
  })

  it('gives duplicate legacy steps deterministic distinct identities', () => {
    expect(planStepRenderKeys([
      { step: 'Test', status: 'pending' },
      { step: 'Test', status: 'completed' },
    ])).toEqual(['legacy:Test:0', 'legacy:Test:1'])
  })

  it('replaces a same-turn plan update while retaining step identities', () => {
    const initial = {
      kind: 'plan',
      id: 'plan-turn-1',
      plan: {
        explanation: null,
        steps: [{ id: 'inspect', step: 'Inspect', status: 'pending' }],
      },
      created_at: '2026-08-09T12:00:00Z',
    } satisfies Extract<ConversationItem, { kind: 'plan' }>
    const updated = {
      ...initial,
      plan: {
        explanation: 'Inspection complete',
        steps: [{ id: 'inspect', step: 'Inspect carefully', status: 'completed' }],
      },
    } satisfies Extract<ConversationItem, { kind: 'plan' }>

    const items = upsertConversationItem([initial], updated)

    expect(items).toHaveLength(1)
    expect(items[0]).toEqual(updated)
    expect(items[0]?.kind === 'plan' ? items[0].plan.steps[0]?.id : null).toBe('inspect')
  })
})

describe('plan step presentations', () => {
  it('keeps only the most recent in-progress step running', () => {
    const states = planStepPresentations([
      { step: 'Inspect', status: 'in_progress' },
      { step: 'Implement', status: 'in_progress' },
      { step: 'Ship', status: 'pending' },
    ]).map((p) => p.state)

    expect(states).toEqual(['completed', 'in_progress', 'pending'])
  })

  it('leaves a single in-progress step untouched', () => {
    const states = planStepPresentations([
      { step: 'Inspect', status: 'completed' },
      { step: 'Implement', status: 'in_progress' },
    ]).map((p) => p.state)

    expect(states).toEqual(['completed', 'in_progress'])
  })
})

describe('pinned plan selection', () => {  it('pins the newest plan of the current turn', () => {
    const pinned = currentTurnPlan([
      userMessage('user-1'),
      planItem('plan-1', [{ step: 'Old', status: 'completed' }]),
      userMessage('user-2'),
      planItem('plan-2', [{ step: 'New', status: 'in_progress' }]),
    ])

    expect(pinned?.itemId).toBe('plan-2')
    expect(pinned?.plan.steps[0]?.step).toBe('New')
  })

  it('drops a plan the user has already replied past', () => {
    expect(
      currentTurnPlan([
        planItem('plan-1', [{ step: 'Old', status: 'completed' }]),
        userMessage('user-2'),
      ]),
    ).toBeNull()
  })

  it('ignores plan items that carry no steps', () => {
    expect(currentTurnPlan([planItem('plan-1', [])])).toBeNull()
  })
})

describe('plan progress', () => {
  it('names the running step and counts finished ones', () => {
    expect(
      planProgress([
        { step: 'Inspect', status: 'completed' },
        { step: 'Implement', status: 'in_progress' },
        { step: 'Ship', status: 'pending' },
      ]),
    ).toEqual({
      completed: 1,
      total: 3,
      current: { step: 'Implement', status: 'in_progress' },
    })
  })

  it('falls back to the next unfinished step when none is running', () => {
    expect(
      planProgress([
        { step: 'Inspect', status: 'completed' },
        { step: 'Ship', status: 'pending' },
      ]).current,
    ).toEqual({ step: 'Ship', status: 'pending' })
  })

  it('reports no current step once every step has finished', () => {
    expect(planProgress([{ step: 'Inspect', status: 'completed' }])).toEqual({
      completed: 1,
      total: 1,
      current: null,
    })
  })
})
