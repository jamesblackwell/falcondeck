import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  MCP_ELICITATION_METHOD,
  type InteractiveRequest,
} from '@falcondeck/client-core'

import { InteractiveRequestCard } from './interactive-request-card'

function request(overrides: Partial<InteractiveRequest> = {}): InteractiveRequest {
  return {
    request_id: 'req-1',
    workspace_id: 'ws-1',
    thread_id: 'thread-1',
    method: 'item/commandExecution/requestApproval',
    kind: 'approval',
    title: 'Allow npm test?',
    detail: 'Runs the suite.',
    command: 'npm test',
    path: null,
    turn_id: 'turn-1',
    item_id: 'item-1',
    questions: [],
    created_at: '2026-08-09T12:00:00Z',
    approval_decisions: ['allow', 'deny'],
    ...overrides,
  }
}

describe('InteractiveRequestCard elicitation', () => {
  it('renders a Cloudflare-style URL prompt as Continue/Cancel with a link', async () => {
    const onRespond = vi.fn(async () => undefined)
    const url = 'https://dash.cloudflare.com/oauth/authorize?client_id=abc'
    render(
      <InteractiveRequestCard
        request={request({
          method: MCP_ELICITATION_METHOD,
          title: 'Sign in to cloudflare',
          detail: 'Sign in to Cloudflare to continue.',
          command: null,
          path: url,
        })}
        onRespond={onRespond}
      />,
    )

    expect(screen.getByText('Sign in required')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: url })).toHaveAttribute('href', url)
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() =>
      expect(onRespond).toHaveBeenCalledWith({ kind: 'approval', decision: 'allow' }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(onRespond).toHaveBeenCalledWith({ kind: 'approval', decision: 'deny' }),
    )
  })

  it('lets form elicitation be declined without answers', async () => {
    const onRespond = vi.fn(async () => undefined)
    render(
      <InteractiveRequestCard
        request={request({
          method: MCP_ELICITATION_METHOD,
          kind: 'question',
          title: 'docs needs more information',
          detail: 'Need a name.',
          command: null,
          approval_decisions: [],
          questions: [
            {
              id: 'name',
              header: 'Name',
              question: 'What should we call this?',
              is_other: false,
              is_secret: false,
              options: null,
            },
          ],
        })}
        onRespond={onRespond}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    await waitFor(() =>
      expect(onRespond).toHaveBeenCalledWith({ kind: 'approval', decision: 'deny' }),
    )
  })
})
