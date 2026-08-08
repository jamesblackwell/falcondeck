import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Conversation } from '@falcondeck/chat-ui'

describe('Conversation empty state', () => {
  it('shows the empty state on an idle empty thread', () => {
    render(<Conversation items={[]} />)

    expect(screen.getByText('Ready for instructions')).toBeInTheDocument()
  })

  it('yields to the thinking indicator once a prompt is submitted', () => {
    // The submit gap: the prompt is in flight but the daemon has not echoed it
    // into the transcript yet, so items is still empty.
    render(<Conversation items={[]} isThinking />)

    expect(screen.queryByText('Ready for instructions')).toBeNull()
    expect(screen.getByText('Thinking…')).toBeInTheDocument()
  })

  it('shows an optimistic sending indicator before daemon activity arrives', () => {
    render(
      <Conversation
        items={[
          {
            kind: 'user_message',
            id: 'user-1',
            text: 'Did you implement it?',
            attachments: [],
            created_at: '2026-08-08T12:00:00Z',
          },
        ]}
        isSending
        isThinking
      />,
    )

    expect(screen.queryByText('Ready for instructions')).toBeNull()
    expect(screen.getByText('Sending…')).toBeInTheDocument()
    expect(screen.queryByText('Thinking…')).toBeNull()
  })

  it('yields to the approval notice when an empty-transcript turn is blocked', () => {
    render(<Conversation items={[]} isWaitingForInput />)

    expect(screen.queryByText('Ready for instructions')).toBeNull()
    expect(screen.getByText(/Waiting for approval/)).toBeInTheDocument()
  })

  it('shows nothing while the thread detail is still loading', () => {
    render(<Conversation items={[]} isLoading />)

    expect(screen.queryByText('Ready for instructions')).toBeNull()
    expect(screen.queryByText('Thinking…')).toBeNull()
  })
})
