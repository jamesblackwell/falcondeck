import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { InteractiveRequest } from '@falcondeck/client-core'
import { InteractiveRequestBar } from '@falcondeck/chat-ui'

function approvalRequest(): InteractiveRequest {
  return {
    request_id: 'request-1',
    workspace_id: 'workspace-1',
    thread_id: 'thread-1',
    kind: 'approval',
    approval_decisions: ['allow', 'deny', 'always_allow'],
    title: 'Allow rm -rf build?',
    detail: null,
    command: 'rm -rf build',
    path: null,
    options: [
      { option_id: 'approve', label: 'Allow', kind: 'approve' },
      { option_id: 'deny', label: 'Deny', kind: 'deny' },
    ],
    questions: [],
    created_at: '2026-08-06T10:00:00Z',
  } as InteractiveRequest
}

function questionRequest(overrides: Partial<InteractiveRequest> = {}): InteractiveRequest {
  return {
    request_id: 'question-1',
    workspace_id: 'workspace-1',
    thread_id: 'thread-1',
    method: 'item/tool/requestUserInput',
    kind: 'question',
    title: 'Deployment details',
    detail: null,
    command: null,
    path: null,
    turn_id: 'turn-1',
    item_id: 'item-1',
    questions: [
      {
        id: 'region',
        header: 'Region',
        question: 'Which region?',
        options: [
          { label: 'London', description: 'UK region' },
          { label: 'Virginia', description: 'US region' },
        ],
        is_other: false,
        is_secret: false,
      },
    ],
    created_at: '2026-08-06T10:00:00Z',
    ...overrides,
  }
}

function planRequest(): InteractiveRequest {
  return {
    request_id: 'plan-1',
    workspace_id: 'workspace-1',
    thread_id: 'thread-1',
    method: 'x.ai/exit_plan_mode',
    kind: 'plan_approval',
    title: 'Review implementation plan',
    detail: '## Ship the fix\n\n1. Add the daemon bridge.\n2. Test reconnects.',
    command: null,
    path: null,
    turn_id: null,
    item_id: 'grok-plan-tool',
    questions: [],
    created_at: '2026-08-06T10:00:00Z',
  }
}

describe('InteractiveRequestBar', () => {
  it('shows only the oldest actionable request and advances when it leaves the queue', () => {
    const oldest = questionRequest({
      request_id: 'question-oldest',
      title: 'Choose the release channel',
      created_at: '2026-08-06T10:00:00Z',
    })
    const newest = {
      ...approvalRequest(),
      request_id: 'approval-newest',
      title: 'Allow the release command?',
      created_at: '2026-08-06T10:00:01Z',
    }
    const onRespond = vi.fn()
    const { rerender } = render(<InteractiveRequestBar requests={[newest, oldest]} onRespond={onRespond} />)

    expect(screen.getByText('2 responses pending')).toBeVisible()
    expect(screen.getByText('1 of 2')).toBeVisible()
    expect(screen.getByText('Choose the release channel')).toBeVisible()
    expect(screen.queryByText('Allow the release command?')).not.toBeInTheDocument()

    rerender(<InteractiveRequestBar requests={[newest]} onRespond={onRespond} />)

    expect(screen.getByText('Allow the release command?')).toBeVisible()
    expect(screen.queryByText('Choose the release channel')).not.toBeInTheDocument()
  })

  it('normalizes approval evidence and keeps long commands fully inspectable', () => {
    const request = approvalRequest()
    request.command = Array.from({ length: 7 }, (_, index) => `release step ${index + 1}`).join('\n')
    request.path = '/workspace/falcondeck'
    request.detail = '{"command":"release","description":"Runs the release suite."}'
    render(<InteractiveRequestBar requests={[request]} onRespond={vi.fn()} />)

    expect(screen.getByText('Runs the release suite.')).toBeVisible()
    expect(screen.getByText('/workspace/falcondeck')).toBeVisible()
    expect(screen.queryByText(/\{"command"/)).toBeNull()
    const code = screen.getByText(
      (_, element) => element?.tagName === 'CODE' && Boolean(element.textContent?.includes('release step 1')),
    )
    expect(code).toHaveTextContent('release step 4')
    expect(code).not.toHaveTextContent('release step 7')

    fireEvent.click(screen.getByRole('button', { name: 'Show 3 more lines' }))

    expect(code).toHaveTextContent('release step 7')
    expect(screen.getByRole('button', { name: /Copy/ })).toBeVisible()
  })

  it('reports a failed approval in the card instead of resetting silently', async () => {
    const onRespond = vi.fn().mockRejectedValue(new Error('relay unreachable'))
    render(<InteractiveRequestBar requests={[approvalRequest()]} onRespond={onRespond} />)

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))

    // Without this the agent stays blocked and the card looks untouched, so
    // the user has no idea their answer never landed.
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('relay unreachable')
    })
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled()
  })

  it('leaves no error behind when the approval succeeds', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)
    render(<InteractiveRequestBar requests={[approvalRequest()]} onRespond={onRespond} />)

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))

    await waitFor(() => {
      expect(onRespond).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('labels and sends the provider-scoped always-allow decision explicitly', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)
    render(<InteractiveRequestBar requests={[approvalRequest()]} onRespond={onRespond} />)

    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }))

    await waitFor(() => {
      expect(onRespond).toHaveBeenCalledWith(expect.objectContaining({ request_id: 'request-1' }), {
        kind: 'approval',
        decision: 'always_allow',
      })
    })
  })

  it('shows only decisions the provider actually offered', () => {
    const request = approvalRequest()
    request.approval_decisions = ['allow', 'deny']
    render(<InteractiveRequestBar requests={[request]} onRespond={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Allow' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Always allow' })).not.toBeInTheDocument()
  })

  it('makes an explicitly unsupported approval visibly non-actionable', () => {
    const request = approvalRequest()
    request.approval_decisions = []
    render(<InteractiveRequestBar requests={[request]} onRespond={vi.fn()} />)

    expect(screen.getByRole('alert')).toHaveTextContent('This provider did not supply an approval decision.')
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument()
  })

  it('renders and approves a Grok plan through the plan-specific response contract', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)
    render(<InteractiveRequestBar requests={[planRequest()]} onRespond={onRespond} />)

    expect(screen.getByRole('heading', { name: 'Ship the fix' })).toBeVisible()
    expect(screen.getByText('Add the daemon bridge.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Request changes' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Approve and implement' }))

    await waitFor(() => {
      expect(onRespond).toHaveBeenCalledWith(expect.objectContaining({ request_id: 'plan-1' }), {
        kind: 'plan_approval',
        outcome: 'approved',
      })
    })
  })

  it('returns plan revision feedback to Grok', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)
    render(<InteractiveRequestBar requests={[planRequest()]} onRespond={onRespond} />)

    fireEvent.change(screen.getByLabelText('Requested plan changes'), {
      target: { value: 'Add a rollback test.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))

    await waitFor(() => {
      expect(onRespond).toHaveBeenCalledWith(expect.objectContaining({ request_id: 'plan-1' }), {
        kind: 'plan_approval',
        outcome: 'cancelled',
        feedback: 'Add a rollback test.',
      })
    })
  })

  it('does not advance a question while an IME candidate is being composed', () => {
    const onRespond = vi.fn()
    const request = questionRequest({
      questions: [{ ...questionRequest().questions[0]!, options: null }],
    })
    render(<InteractiveRequestBar requests={[request]} onRespond={onRespond} />)

    const input = screen.getByLabelText('Which region?')
    fireEvent.change(input, { target: { value: '東京' } })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true })

    expect(onRespond).not.toHaveBeenCalled()
    expect(input).toBeInTheDocument()
  })

  it('exposes option choices with native radio semantics', () => {
    render(<InteractiveRequestBar requests={[questionRequest()]} onRespond={vi.fn()} />)

    const london = screen.getByRole('radio', { name: /London/ })
    expect(london).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(london)
    expect(london).toHaveAttribute('aria-checked', 'true')
  })

  it('surfaces a malformed empty question instead of rendering dead controls', () => {
    render(<InteractiveRequestBar requests={[questionRequest({ questions: [] })]} onRespond={vi.fn()} />)

    expect(screen.getByRole('alert')).toHaveTextContent('did not supply a question')
    expect(screen.queryByRole('button', { name: 'Submit answer' })).not.toBeInTheDocument()
  })
})
