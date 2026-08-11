import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MessageCard } from '@falcondeck/chat-ui'
import type { ConversationItem, ToolLifecycle } from '@falcondeck/client-core'

function item(lifecycle: ToolLifecycle): Extract<ConversationItem, { kind: 'tool_call' }> {
  return {
    kind: 'tool_call',
    id: `tool-${lifecycle}`,
    title: 'Run checks',
    tool_kind: 'commandExecution',
    status: 'provider_specific',
    output: 'Details',
    exit_code: null,
    display: {
      is_read_only: false,
      has_side_effect: true,
      is_error: lifecycle === 'failed' || lifecycle === 'denied',
      lifecycle,
      artifact_kind: 'command_output',
      activity_kind: 'command',
      history_mode: 'full',
      summary_hint: null,
    },
    created_at: '2026-08-08T20:00:00Z',
    completed_at: lifecycle === 'running' ? null : '2026-08-08T20:00:01Z',
  }
}

describe('tool lifecycle presentation', () => {
  it.each<[ToolLifecycle, string]>([
    ['queued', 'Queued'],
    ['awaiting_approval', 'Awaiting approval'],
    ['running', 'Running'],
    ['succeeded', 'Completed'],
    ['failed', 'Failed'],
    ['denied', 'Denied'],
    ['interrupted', 'Interrupted'],
    ['unknown', 'Unknown status'],
  ])('exposes %s as accessible status', (lifecycle, label) => {
    const { unmount } = render(<MessageCard item={item(lifecycle)} />)
    expect(screen.getByRole('button', { name: new RegExp(`${label}$`) })).toHaveAttribute(
      'aria-live',
      'polite',
    )
    unmount()
  })

  it('keeps approval detail visible and non-collapsible while waiting', () => {
    render(<MessageCard item={item('awaiting_approval')} />)
    const trigger = screen.getByRole('button', { name: /Awaiting approval$/ })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Details')).toBeVisible()
  })

  it('does not expose a dead disclosure action when there is no detail', () => {
    render(<MessageCard item={{ ...item('queued'), output: null }} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Run checks, Queued')).toHaveAttribute('aria-live', 'polite')
  })
})
