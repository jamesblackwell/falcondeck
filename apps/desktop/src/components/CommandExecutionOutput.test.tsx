import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MessageCard } from '@falcondeck/chat-ui'
import type { ConversationItem } from '@falcondeck/client-core'

const item: Extract<ConversationItem, { kind: 'tool_call' }> = {
  kind: 'tool_call',
  id: 'command-1',
  title: 'rg streaming src',
  tool_kind: 'commandExecution',
  status: 'completed',
  output: 'src/chat.ts:42',
  exit_code: 0,
  display: {
    is_read_only: true,
    has_side_effect: false,
    is_error: false,
    lifecycle: 'succeeded',
    artifact_kind: 'command_output',
    activity_kind: 'search',
    history_mode: 'full',
    summary_hint: null,
  },
  detail: {
    kind: 'command_execution',
    command: 'rg streaming src',
    cwd: '/workspace/falcondeck',
    actions: [{
      action_kind: 'search',
      command: 'rg streaming src',
      name: null,
      path: 'src',
      query: 'streaming',
    }],
    process_id: '4242',
    duration_ms: 37,
    source: 'agent',
  },
  created_at: '2026-08-09T10:00:00Z',
  completed_at: '2026-08-09T10:00:01Z',
}

describe('structured command execution output', () => {
  it('reveals working directory, duration, action, query, and output', () => {
    render(<MessageCard item={item} />)
    const disclosure = screen.getByRole('button', { name: /Completed$/ })
    fireEvent.click(disclosure)
    expect(screen.getByText('cwd: /workspace/falcondeck')).toBeVisible()
    expect(screen.getByText('37 ms')).toBeVisible()
    expect(screen.getByText('search · src · streaming')).toBeVisible()
    expect(screen.getByText('src/chat.ts:42')).toBeVisible()
  })

  it('preserves quotes inside an exact command title', () => {
    render(<MessageCard item={{ ...item, title: 'rg "streaming" src' }} />)
    expect(screen.getByRole('button', { name: /rg "streaming" src details, Completed$/ })).toBeVisible()
  })

  it('bounds pathological output after expansion without losing the copy action', () => {
    const output = Array.from({ length: 1_200 }, (_, index) => `line ${index + 1}`).join('\n')
    render(<MessageCard item={{ ...item, output }} />)

    fireEvent.click(screen.getByRole('button', { name: /Completed$/ }))
    fireEvent.click(screen.getByText('Show 986 more lines'))

    const outputBlock = document.querySelector('pre')
    expect(outputBlock).toHaveTextContent('line 1000')
    expect(outputBlock).not.toHaveTextContent('line 1001')
    expect(screen.getByRole('status')).toHaveTextContent('Copy includes the complete output')
    expect(screen.getByRole('button', { name: 'Copy' })).toBeVisible()
  })
})
