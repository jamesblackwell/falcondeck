import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type {
  ConversationItem,
  FalconDeckPreferences,
  ThinkingDisplay,
  ToolCallDisplay,
} from '@falcondeck/client-core'
import { normalizePreferences } from '@falcondeck/client-core'
import { Conversation } from '@falcondeck/chat-ui'

const THOUGHT = 'Checking whether the daemon already emits this item.'

function reasoning(
  overrides: Partial<Extract<ConversationItem, { kind: 'reasoning' }>> = {},
): ConversationItem {
  return {
    kind: 'reasoning',
    id: 'reasoning-1',
    summary: 'Planning the change',
    content: THOUGHT,
    created_at: '2026-08-06T10:00:00Z',
    ...overrides,
  }
}

function toolDisplay(overrides: Partial<ToolCallDisplay> = {}): ToolCallDisplay {
  return {
    is_read_only: true,
    has_side_effect: false,
    is_error: false,
    artifact_kind: 'none',
    activity_kind: 'read',
    history_mode: 'summary',
    summary_hint: null,
    ...overrides,
  }
}

function toolCall(
  overrides: Partial<Extract<ConversationItem, { kind: 'tool_call' }>> = {},
): ConversationItem {
  return {
    kind: 'tool_call',
    id: 'tool-1',
    title: 'Read src/app.ts',
    tool_kind: 'read',
    status: 'completed',
    output: 'file contents',
    exit_code: 0,
    display: toolDisplay(),
    created_at: '2026-08-06T10:00:00Z',
    completed_at: '2026-08-06T10:00:01Z',
    ...overrides,
  }
}

function preferences(thinkingDisplay: ThinkingDisplay): FalconDeckPreferences {
  const base = normalizePreferences(null)
  return { ...base, conversation: { ...base.conversation, thinking_display: thinkingDisplay } }
}

describe('reasoning reveal', () => {
  it('makes a thought reachable instead of dropping it from the transcript', () => {
    render(<Conversation items={[reasoning()]} />)

    // The header alone proves the item survived the render pipeline; before
    // this it was filtered out of the item list and returned null downstream.
    expect(screen.getByRole('button', { name: /Planning the change/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Planning the change/ }))
    expect(screen.getByText(THOUGHT)).toBeInTheDocument()
  })

  it('auto-expands the streaming thought and collapses it once the stream ends', () => {
    const { rerender } = render(<Conversation items={[reasoning()]} isThinking />)

    expect(screen.getByText(THOUGHT)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Thinking…/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )

    rerender(<Conversation items={[reasoning()]} isThinking={false} />)
    expect(screen.queryByText(THOUGHT)).not.toBeInTheDocument()
  })

  it('keeps a thought the reader opened open after the stream ends', () => {
    const { rerender } = render(<Conversation items={[reasoning()]} isThinking />)

    // Toggling twice lands back on "open", but now as an explicit choice that
    // must outlive the stream rather than a value derived from it.
    const toggle = screen.getByRole('button', { name: /Thinking…/ })
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: /Thinking…/ }))

    rerender(<Conversation items={[reasoning()]} isThinking={false} />)
    expect(screen.getByText(THOUGHT)).toBeInTheDocument()
  })

  it('height-caps the excerpt in preview mode and promotes it on click', () => {
    render(<Conversation items={[reasoning()]} preferences={preferences('preview')} />)

    // Preview keeps the body mounted while closed — that is what distinguishes
    // it from the collapsed modes.
    expect(screen.getByText(THOUGHT)).toBeInTheDocument()
    const promote = screen.getByRole('button', { name: 'Show the full thought' })
    fireEvent.click(promote)
    expect(screen.queryByRole('button', { name: 'Show the full thought' })).not.toBeInTheDocument()
    expect(screen.getByText(THOUGHT)).toBeInTheDocument()
  })

  it('hides the body but keeps the toggle in always-collapsed mode', () => {
    render(
      <Conversation
        items={[reasoning()]}
        isThinking
        preferences={preferences('always_collapsed')}
      />,
    )

    expect(screen.queryByText(THOUGHT)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Thinking…/ }))
    expect(screen.getByText(THOUGHT)).toBeInTheDocument()
  })

  it('does not offer an empty thought as an expandable control', () => {
    render(
      <Conversation
        items={[reasoning({ summary: null, content: '', duration_ms: 1400 })]}
      />,
    )

    expect(
      screen.queryByRole('button', { name: /Thought/ }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Thought')).toBeInTheDocument()
    expect(screen.getByText(/1.4 s/)).toBeInTheDocument()
  })

  it('opens the body immediately in always-expanded mode', () => {
    render(<Conversation items={[reasoning()]} preferences={preferences('always_expanded')} />)

    expect(screen.getByText(THOUGHT)).toBeInTheDocument()
  })

  it('folds reasoning into the work run it interleaves with instead of splitting it', () => {
    render(
      <Conversation
        items={[
          toolCall({ id: 'tool-1' }),
          reasoning(),
          toolCall({ id: 'tool-2', title: 'Read src/other.ts' }),
        ]}
      />,
    )

    // One run, not two: a thought between tool calls must not shatter the fold
    // into a column of one-second "Worked for" rows.
    const runs = screen.getAllByRole('button', { name: /Worked for/ })
    expect(runs).toHaveLength(1)

    fireEvent.click(runs[0])
    expect(screen.getByRole('button', { name: /Planning the change/ })).toBeInTheDocument()
  })
})

describe('live thread indicators', () => {
  it('keeps the work session alive while a trailing thought streams', () => {
    // Regression: all tools done + a streaming thought at the tail used to
    // render "Worked for 43s" with no indicator anywhere — a running thread
    // that looked settled.
    render(
      <Conversation
        items={[toolCall({ id: 'tool-1' }), reasoning({ id: 'reasoning-tail' })]}
        isThinking
      />,
    )

    expect(screen.queryByRole('button', { name: /Worked for/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Thinking…/ })).toBeInTheDocument()
  })

  it('keeps the work session alive between fast tool calls', () => {
    const { rerender } = render(
      <Conversation items={[toolCall({ id: 'tool-1' })]} isThinking />,
    )

    expect(screen.queryByRole('button', { name: /Worked for/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Working…/ })).toBeInTheDocument()

    rerender(<Conversation items={[toolCall({ id: 'tool-1' })]} isThinking={false} />)
    expect(screen.getByRole('button', { name: /Worked for/ })).toBeInTheDocument()
  })

  it('settles the session back to "Worked for" once the turn ends', () => {
    const { rerender } = render(
      <Conversation
        items={[toolCall({ id: 'tool-1' }), reasoning({ id: 'reasoning-tail' })]}
        isThinking
      />,
    )

    rerender(
      <Conversation
        items={[toolCall({ id: 'tool-1' }), reasoning({ id: 'reasoning-tail' })]}
        isThinking={false}
      />,
    )
    expect(screen.getByRole('button', { name: /Worked for/ })).toBeInTheDocument()
  })

  it('labels a live session by its running tool, not the thinking tail', () => {
    render(
      <Conversation
        items={[
          toolCall({ id: 'tool-1', status: 'running', completed_at: null }),
          reasoning({ id: 'reasoning-tail' }),
        ]}
        isThinking
      />,
    )

    // A tool is still mid-flight, so the trailing thought must not flip the
    // session's label over to "Thinking…".
    expect(screen.getByRole('button', { name: /Working…/ })).toBeInTheDocument()
  })

  it('pins a waiting-for-approval notice that no fold can hide', () => {
    // While an approval is pending the thread is not "thinking", but it must
    // never look idle either — the turn is blocked on the reader.
    render(
      <Conversation
        items={[toolCall({ id: 'tool-1' }), reasoning({ id: 'reasoning-tail' })]}
        isWaitingForInput
      />,
    )

    expect(screen.getByText(/Waiting for approval/)).toBeInTheDocument()
    expect(screen.queryByText('Thinking…')).not.toBeInTheDocument()
  })

  it('shows the waiting notice on an empty thread too', () => {
    render(<Conversation items={[]} isWaitingForInput />)

    expect(screen.getByText(/Waiting for approval/)).toBeInTheDocument()
  })
})
