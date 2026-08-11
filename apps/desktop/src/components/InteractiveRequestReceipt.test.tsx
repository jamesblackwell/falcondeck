import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ConversationItem, InteractiveRequestOutcome } from '@falcondeck/client-core'
import { Conversation } from '@falcondeck/chat-ui'

function receipt(
  outcome?: InteractiveRequestOutcome,
  kind: 'approval' | 'question' = 'approval',
): Extract<ConversationItem, { kind: 'interactive_request' }> {
  return {
    kind: 'interactive_request',
    id: `request-${outcome ?? 'legacy'}`,
    request: {
      request_id: `request-${outcome ?? 'legacy'}`,
      workspace_id: 'workspace-1',
      thread_id: 'thread-1',
      method: kind === 'approval' ? 'approval/request' : 'item/tool/requestUserInput',
      kind,
      title: kind === 'approval' ? 'Allow npm test?' : 'Choose release settings?',
      detail: null,
      command: kind === 'approval' ? 'npm test' : null,
      path: null,
      turn_id: 'turn-1',
      item_id: null,
      questions: [],
      created_at: '2026-08-09T12:00:00Z',
    },
    created_at: '2026-08-09T12:00:00Z',
    resolved: true,
    ...(outcome
      ? { resolution: { outcome, resolved_at: '2026-08-09T12:01:00Z' } }
      : {}),
  }
}

describe('interactive request history receipts', () => {
  it.each([
    ['allowed', 'Allowed npm test'],
    ['always_allowed', 'Always allowed npm test'],
    ['denied', 'Denied npm test'],
    ['expired', 'Expired: Allow npm test'],
    ['cancelled', 'Cancelled: Allow npm test'],
  ] as const)('renders %s without inferring another outcome', (outcome, label) => {
    render(<Conversation items={[receipt(outcome)]} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('renders answered questions without exposing answer values', () => {
    render(<Conversation items={[receipt('answered', 'question')]} />)
    expect(screen.getByText('Answered: Choose release settings')).toBeInTheDocument()
  })

  it('keeps legacy boolean-only history neutral', () => {
    render(<Conversation items={[receipt()]} />)
    expect(screen.getByText('Resolved: Allow npm test')).toBeInTheDocument()
    expect(screen.queryByText('Allowed npm test')).not.toBeInTheDocument()
  })

  it('expands complete normalized approval evidence without raw transport JSON', () => {
    const item = receipt('denied')
    item.request.command = 'npm run verify'
    item.request.path = '/workspace/falcondeck'
    item.request.detail = '{"command":"npm run verify","description":"Runs the release suite."}'
    render(<Conversation items={[item]} />)

    const disclosure = screen.getByRole('button', { name: /Denied npm test/ })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Runs the release suite.')).toBeNull()
    fireEvent.click(disclosure)

    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByText('npm run verify')).toHaveLength(2)
    expect(screen.getByText('/workspace/falcondeck')).toBeVisible()
    expect(screen.getByText('Runs the release suite.')).toBeVisible()
    expect(screen.queryByText(/\{"command"/)).toBeNull()
  })

  it('expands answered question prompts and options without retaining answers', () => {
    const item = receipt('answered', 'question')
    item.request.questions = [{
      id: 'channel',
      header: 'Channel',
      question: 'Which release channel should be used?',
      is_other: false,
      is_secret: false,
      options: [{ label: 'Preview', description: 'Ship internally first.' }],
    }]
    render(<Conversation items={[item]} />)

    fireEvent.click(screen.getByRole('button', { name: /Answered: Choose release settings/ }))

    expect(screen.getAllByText('Which release channel should be used?')).toHaveLength(2)
    expect(screen.getByText(/Preview/)).toBeVisible()
    expect(screen.queryByText('do-not-retain-this')).toBeNull()
  })
})
