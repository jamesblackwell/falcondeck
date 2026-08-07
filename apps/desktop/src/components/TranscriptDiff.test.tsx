import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ConversationItem, ToolCallDisplay } from '@falcondeck/client-core'
import { Conversation } from '@falcondeck/chat-ui'

const SAMPLE_DIFF = [
  'diff --git a/src/greet.ts b/src/greet.ts',
  'index 1111111..2222222 100644',
  '--- a/src/greet.ts',
  '+++ b/src/greet.ts',
  '@@ -1,3 +1,3 @@',
  ' export function greet(name: string) {',
  '-  return `hi ${name}`',
  '+  return `hello ${name}`',
  ' }',
].join('\n')

function display(overrides: Partial<ToolCallDisplay> = {}): ToolCallDisplay {
  return {
    is_read_only: false,
    has_side_effect: true,
    is_error: false,
    artifact_kind: 'diff',
    activity_kind: 'edit',
    history_mode: 'full',
    summary_hint: null,
    ...overrides,
  }
}

/** Diff-bearing tool calls surface expanded by default, so no click is needed. */
function toolCall(
  overrides: Partial<Extract<ConversationItem, { kind: 'tool_call' }>> = {},
): ConversationItem {
  return {
    kind: 'tool_call',
    id: 'tool-1',
    title: 'Edit src/greet.ts',
    tool_kind: 'edit',
    status: 'completed',
    output: SAMPLE_DIFF,
    exit_code: 0,
    display: display(),
    created_at: '2026-08-06T10:00:00Z',
    completed_at: '2026-08-06T10:00:01Z',
    ...overrides,
  }
}

function renderTranscript(items: ConversationItem[], onOpenFile?: (path: string) => void) {
  return render(<Conversation items={items} onOpenFile={onOpenFile ?? null} />)
}

describe('transcript diff rendering', () => {
  it('renders a tool call whose output is a unified diff as a diff, not raw text', () => {
    renderTranscript([toolCall()])

    // The hunk header and un-prefixed change lines are the diff renderer's
    // signature; plain output would still carry the leading +/- characters.
    expect(screen.getByText('@@ -1,3 +1,3 @@')).toBeTruthy()
    expect(screen.getByText('return `hello ${name}`')).toBeTruthy()
    expect(screen.getByText('return `hi ${name}`')).toBeTruthy()
  })

  it('renders a diff conversation item through the diff renderer', () => {
    renderTranscript([
      { kind: 'diff', id: 'diff-1', diff: SAMPLE_DIFF, created_at: '2026-08-06T10:00:00Z' },
    ])

    expect(screen.getByText('@@ -1,3 +1,3 @@')).toBeTruthy()
    // One hunk header plus four change rows.
    expect(screen.getByText('5 lines')).toBeTruthy()
  })

  it('opens the edited file in the side panel when its path is clicked', () => {
    const onOpenFile = vi.fn()
    renderTranscript([toolCall()], onOpenFile)

    fireEvent.click(screen.getByText('greet.ts'))
    expect(onOpenFile).toHaveBeenCalledWith('src/greet.ts')

    // The diff's own header names the file too, and opens the same panel.
    fireEvent.click(screen.getByText('src/greet.ts'))
    expect(onOpenFile).toHaveBeenCalledTimes(2)
  })

  it('leaves file paths inert when the host offers nowhere to open them', () => {
    renderTranscript([toolCall()])

    expect(screen.queryByTitle('Open src/greet.ts in the changes panel')).toBeNull()
  })

  it('caps a long diff and reveals the rest on demand', () => {
    const longDiff = [
      'diff --git a/src/big.ts b/src/big.ts',
      '--- a/src/big.ts',
      '+++ b/src/big.ts',
      '@@ -1,40 +1,40 @@',
      ...Array.from({ length: 40 }, (_, index) => `+line ${index}`),
    ].join('\n')

    renderTranscript([toolCall({ id: 'tool-2', output: longDiff })])

    expect(screen.queryByText('line 39')).toBeNull()

    // 40 change rows plus one hunk header, capped at 14.
    fireEvent.click(screen.getByText('Show 27 more lines'))
    expect(screen.getByText('line 39')).toBeTruthy()
  })
})
