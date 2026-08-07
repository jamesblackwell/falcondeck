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

describe('InteractiveRequestBar', () => {
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
})
