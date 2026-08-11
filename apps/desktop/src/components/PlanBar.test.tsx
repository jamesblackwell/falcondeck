import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Conversation, PlanBar } from '@falcondeck/chat-ui'
import type { ConversationItem } from '@falcondeck/client-core'

const plan = {
  explanation: 'Ship the pinned plan.',
  steps: [
    { id: 'inspect', step: 'Inspect current state', status: 'completed' },
    { id: 'implement', step: 'Implement parity', status: 'in_progress' },
    { id: 'qa', step: 'QA every client', status: 'pending' },
  ],
}

const planItem = {
  kind: 'plan',
  id: 'plan-1',
  plan,
  created_at: '2026-08-09T12:00:00Z',
} satisfies Extract<ConversationItem, { kind: 'plan' }>

describe('PlanBar', () => {
  it('summarizes the running step and progress while collapsed', () => {
    render(<PlanBar plan={plan} />)

    const toggle = screen.getByRole('button', {
      name: 'Plan, 1 of 3 steps complete',
    })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Implement parity')).toBeInTheDocument()
    expect(screen.getByText('1/3')).toBeInTheDocument()
    // Collapsed shows only the current step, not the whole checklist.
    expect(screen.queryByText('QA every client')).toBeNull()
  })

  it('expands to the full checklist and collapses again', () => {
    render(<PlanBar plan={plan} />)
    const toggle = screen.getByRole('button', {
      name: 'Plan, 1 of 3 steps complete',
    })

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('Inspect current state, Completed')).toBeInTheDocument()
    expect(screen.getByLabelText('QA every client, Pending')).toBeInTheDocument()
    expect(screen.getByText('Ship the pinned plan.')).toBeInTheDocument()

    fireEvent.click(toggle)
    expect(screen.queryByText('QA every client')).toBeNull()
  })

  it('reports completion once no step is left', () => {
    render(
      <PlanBar
        plan={{
          explanation: null,
          steps: [{ id: 'inspect', step: 'Inspect', status: 'completed' }],
        }}
      />,
    )

    expect(screen.getByText('All steps complete')).toBeInTheDocument()
  })
})

describe('transcript plan deduplication', () => {
  it('drops the pinned plan from the transcript but keeps unpinned ones', () => {
    const { rerender } = render(<Conversation items={[planItem]} />)
    expect(screen.getByRole('region', { name: 'Plan, 3 steps' })).toBeInTheDocument()

    rerender(<Conversation items={[planItem]} pinnedPlanId="plan-1" />)
    expect(screen.queryByRole('region', { name: 'Plan, 3 steps' })).toBeNull()
  })
})
