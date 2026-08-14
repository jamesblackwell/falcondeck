import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MessageCard } from '@falcondeck/chat-ui'
import type {
  ContentLifecycle,
  ConversationItem,
} from '@falcondeck/client-core'

const createdAt = '2026-08-08T20:00:00Z'

function assistant(
  lifecycle: ContentLifecycle,
  text = 'Partial response',
  error?: string,
) {
  return {
    kind: 'assistant_message',
    id: 'assistant-1',
    text,
    lifecycle,
    error,
    created_at: createdAt,
  } satisfies Extract<ConversationItem, { kind: 'assistant_message' }>
}

function reasoning(lifecycle: ContentLifecycle, durationMs?: number) {
  return {
    kind: 'reasoning',
    id: 'reasoning-1',
    summary: 'Inspecting the renderer',
    content: 'Reasoning detail',
    lifecycle,
    duration_ms: durationMs,
    created_at: createdAt,
  } satisfies Extract<ConversationItem, { kind: 'reasoning' }>
}

describe('assistant content lifecycle presentation', () => {
  it('marks a streaming response busy without adding a terminal warning', () => {
    render(<MessageCard item={assistant('streaming')} />)
    expect(
      screen.getByRole('article', { name: 'Assistant message, streaming' }),
    ).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('keeps partial text copyable and exposes interruption', () => {
    render(<MessageCard item={assistant('interrupted')} />)
    expect(screen.getByRole('status')).toHaveTextContent('Response interrupted')
    expect(
      screen.getByRole('button', { name: 'Copy response' }),
    ).toBeInTheDocument()
  })

  it('keeps an interrupted response visible when no text arrived', () => {
    render(<MessageCard item={assistant('interrupted', '')} />)
    expect(screen.getByRole('status')).toHaveTextContent('Response interrupted')
    expect(
      screen.queryByRole('button', { name: 'Copy response' }),
    ).not.toBeInTheDocument()
  })

  it('exposes a failed response even when no text arrived', () => {
    render(<MessageCard item={assistant('error', '')} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Response failed')
    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive')
    expect(
      screen.queryByRole('button', { name: 'Copy response' }),
    ).not.toBeInTheDocument()
  })

  it('surfaces the provider error on a failed response', () => {
    render(
      <MessageCard
        item={assistant(
          'error',
          '',
          'DeepSeek rejected the request: insufficient credits',
        )}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Response failed DeepSeek rejected the request: insufficient credits',
    )
  })

  it('renders an honest pending receipt before the first fragment', () => {
    render(<MessageCard item={assistant('pending', '')} />)
    expect(screen.getByRole('status')).toHaveTextContent('Preparing response…')
  })
})

describe('reasoning content lifecycle presentation', () => {
  it('auto-expands while streaming and collapses when settled', () => {
    const { rerender } = render(<MessageCard item={reasoning('streaming')} />)
    const trigger = screen.getByRole('button', { name: 'Thinking…' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Reasoning detail')).toBeVisible()

    rerender(<MessageCard item={reasoning('complete')} />)
    expect(
      screen.getByRole('button', { name: 'Inspecting the renderer' }),
    ).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Reasoning detail')).not.toBeInTheDocument()
  })

  it.each([
    ['interrupted', 'Thought interrupted'],
    ['error', 'Thought failed'],
  ] as const)('labels %s reasoning honestly', (lifecycle, label) => {
    const { unmount } = render(<MessageCard item={reasoning(lifecycle)} />)
    const trigger = screen.getByRole('button', { name: label })
    expect(trigger).toHaveAttribute(
      'aria-live',
      lifecycle === 'error' ? 'assertive' : 'polite',
    )
    unmount()
  })

  it('shows authoritative duration only after reasoning settles', () => {
    const { rerender } = render(
      <MessageCard item={reasoning('streaming', 2690)} />,
    )
    expect(screen.queryByText('· 2.7 s')).not.toBeInTheDocument()

    rerender(<MessageCard item={reasoning('complete', 2690)} />)
    expect(
      screen.getByRole('button', { name: 'Inspecting the renderer, 2.7 s' }),
    ).toBeVisible()
    expect(screen.getByText('· 2.7 s')).toBeVisible()
  })
})
