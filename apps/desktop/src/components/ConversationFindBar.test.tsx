import { fireEvent, render, screen, waitForElementToBeRemoved } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ConversationFindBar } from './ConversationFindBar'
import { findTranscriptMatches } from './conversation-find'

describe('ConversationFindBar', () => {
  it('opens on request and searches forward or backward', () => {
    const view = (requestKey: number) => (
      <>
        <div>shortcut outside the transcript</div>
        <div data-conversation-transcript>
          first shortcut and second <strong>shortcut across markup</strong>
        </div>
        <ConversationFindBar requestKey={requestKey} />
      </>
    )
    const { rerender } = render(view(0))
    expect(screen.queryByRole('search', { name: 'Find in chat' })).not.toBeInTheDocument()

    rerender(view(1))
    const input = screen.getByLabelText('Find text')
    fireEvent.change(input, { target: { value: 'shortcut' } })
    const ranges = findTranscriptMatches('shortcut')
    expect(ranges).toHaveLength(2)
    expect(ranges[0]?.toString()).toBe('shortcut')
    expect(ranges[0]?.commonAncestorContainer.parentElement).toHaveAttribute('data-conversation-transcript')
    expect(findTranscriptMatches('second shortcut across')).toHaveLength(1)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.queryByText('No match')).not.toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(screen.queryByText('No match')).not.toBeInTheDocument()
  })

  it('shows a miss and closes with Escape', async () => {
    render(
      <>
        <div data-conversation-transcript>available conversation text</div>
        <ConversationFindBar requestKey={1} />
      </>,
    )
    const input = screen.getByLabelText('Find text')
    fireEvent.change(input, { target: { value: 'missing' } })
    fireEvent.click(screen.getByLabelText('Next match'))
    expect(screen.getByText('No match')).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Escape' })
    // The bar collapses out before unmounting.
    await waitForElementToBeRemoved(() =>
      screen.queryByRole('search', { name: 'Find in chat' }),
    )
  })
})
