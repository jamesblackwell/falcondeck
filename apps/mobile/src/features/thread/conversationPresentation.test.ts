import { describe, expect, it } from 'vitest'

import {
  deriveConversationPresentation,
  type ConversationItem,
  type FalconDeckPreferences,
} from '@falcondeck/client-core'

const preferences: FalconDeckPreferences = {
  version: 1,
  conversation: {
    tool_details_mode: 'compact',
    auto_expand: {
      approvals: true,
      errors: true,
      first_diff: true,
      failed_tests: true,
    },
    group_read_only_tools: true,
    show_expand_all_controls: true,
  },
}

function toolCall(
  overrides: Partial<Extract<ConversationItem, { kind: 'tool_call' }>>,
): Extract<ConversationItem, { kind: 'tool_call' }> {
  return {
    kind: 'tool_call',
    id: 'tool-1',
    title: 'Read package.json',
    tool_kind: 'commandExecution',
    status: 'completed',
    output: '{}',
    exit_code: 0,
    display: {
      is_read_only: true,
      has_side_effect: false,
      is_error: false,
      artifact_kind: 'none',
      activity_kind: 'read',
      history_mode: 'summary',
      summary_hint: 'Read package.json',
    },
    created_at: '2026-03-16T10:00:00Z',
    completed_at: '2026-03-16T10:00:01Z',
    ...overrides,
  }
}

describe('deriveConversationPresentation', () => {
  it('keeps running summary-mode tools in the live activity lane only', () => {
    const presentation = deriveConversationPresentation(
      [
        {
          kind: 'assistant_message',
          id: 'assistant-1',
          text: 'Checking the repo',
          created_at: '2026-03-16T10:00:00Z',
        },
        toolCall({
          id: 'tool-running',
          status: 'running',
          output: null,
          exit_code: null,
          completed_at: null,
          created_at: '2026-03-16T10:00:01Z',
        }),
      ],
      preferences,
    )

    expect(presentation.history_blocks.map((block) => block.kind)).toEqual(['item'])
    expect(presentation.live_activity_groups).toHaveLength(1)
    expect(presentation.live_activity_groups[0]?.summary.title).toContain('Exploring')
  })

  it('compacts completed summary-mode tools while preserving high-signal items inline', () => {
    const presentation = deriveConversationPresentation(
      [
        toolCall({
          id: 'tool-read',
          title: 'Read package.json',
          display: {
            is_read_only: true,
            has_side_effect: false,
            is_error: false,
            artifact_kind: 'none',
            activity_kind: 'read',
            history_mode: 'summary',
            summary_hint: 'Read package.json',
          },
        }),
        toolCall({
          id: 'tool-search',
          title: 'Search workspace',
          display: {
            is_read_only: true,
            has_side_effect: false,
            is_error: false,
            artifact_kind: 'none',
            activity_kind: 'search',
            history_mode: 'summary',
            summary_hint: 'Search workspace',
          },
        }),
        {
          kind: 'diff',
          id: 'diff-1',
          diff: '+added',
          created_at: '2026-03-16T10:00:03Z',
        },
      ],
      preferences,
    )

    expect(presentation.live_activity_groups).toHaveLength(0)
    expect(presentation.history_blocks.map((block) => block.kind)).toEqual([
      'tool_summary',
      'item',
    ])
    expect(presentation.history_blocks[0]?.kind === 'tool_summary' && presentation.history_blocks[0].summary.title).toBe('Explored 1 file, 1 search')
    expect(presentation.history_blocks[1]?.kind).toBe('item')
  })
})
