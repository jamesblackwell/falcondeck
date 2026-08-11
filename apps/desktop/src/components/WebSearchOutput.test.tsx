import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MessageCard } from '@falcondeck/chat-ui'
import type { ContentLifecycle, ConversationItem, WebSearchActionKind } from '@falcondeck/client-core'

function searchItem(
  lifecycle: ContentLifecycle,
  actionKind: WebSearchActionKind = 'search',
  url: string | null = null,
) {
  return {
    kind: 'web_search',
    id: `search-${lifecycle}`,
    search: {
      id: `search-${lifecycle}-action`,
      query: 'React streaming chat best practices',
      action_kind: actionKind,
      queries: ['React streaming chat', 'AI message parts'],
      url,
      pattern: actionKind === 'find_in_page' ? 'streaming' : null,
    },
    lifecycle,
    created_at: '2026-08-09T12:00:00Z',
  } satisfies Extract<ConversationItem, { kind: 'web_search' }>
}

describe('web search output presentation', () => {
  it('shows streaming research as an accessible busy receipt', () => {
    render(<MessageCard item={searchItem('streaming')} />)
    expect(screen.getByRole('article', { name: /Searching web.*streaming/ })).toHaveAttribute(
      'aria-busy',
      'true',
    )
    expect(screen.getByText('2 related queries')).toBeInTheDocument()
    expect(screen.queryByText('AI message parts')).not.toBeVisible()
    fireEvent.click(screen.getByText('2 related queries'))
    expect(screen.getByText('AI message parts')).toBeVisible()
  })

  it('renders open-page actions as safe source links', () => {
    render(<MessageCard item={searchItem('complete', 'open_page', 'https://docs.example.com/chat')} />)
    expect(screen.getByRole('link', { name: 'Open source page on docs.example.com' })).toHaveAttribute(
      'href',
      'https://docs.example.com/chat',
    )
    expect(screen.getByText('Opened page')).toBeInTheDocument()
  })

  it('does not make non-http provider URLs interactive', () => {
    render(<MessageCard item={searchItem('complete', 'open_page', 'javascript:alert(1)')} />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('does not expose credential-bearing or control-character URLs as actions', () => {
    const { rerender } = render(
      <MessageCard item={searchItem(
        'complete',
        'open_page',
        'https://user:secret@example.com/research',
      )} />,
    )
    expect(screen.queryByRole('link')).not.toBeInTheDocument()

    rerender(
      <MessageCard item={searchItem('complete', 'open_page', 'https://example.com/\nresearch')} />,
    )
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('preserves find context and terminal failure state', () => {
    render(<MessageCard item={searchItem('error', 'find_in_page', 'https://example.com')} />)
    expect(screen.getByText('Find: streaming')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Failed')
  })

  it('retains interrupted research as a partial, announced receipt', () => {
    render(<MessageCard item={searchItem('interrupted', 'open_page', 'https://example.com')} />)
    expect(screen.getByText('Opened page')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Interrupted')
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com')
  })

  it('keeps future provider actions intelligible', () => {
    render(<MessageCard item={searchItem('streaming', 'capturePage')} />)

    expect(screen.getByText('Capture page…')).toBeInTheDocument()
  })
})
