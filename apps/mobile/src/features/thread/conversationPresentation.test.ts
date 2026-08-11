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
    thinking_display: 'auto',
  },
  notifications: {
    enabled: true,
    notify_on_turn_complete: true,
    notify_on_input_required: true,
    notify_on_error: true,
    suppress_when_desktop_active: true,
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

describe('collapsed mode grouping', () => {
  const collapsed: FalconDeckPreferences = {
    ...preferences,
    conversation: { ...preferences.conversation, tool_details_mode: 'collapsed' },
  }

  it('keeps one work session when service notices and resolved approvals interleave', () => {
    // The exact shape that used to shred one run into a column of
    // "Worked for 1s" rows: hook chatter and approval receipts between tools.
    const presentation = deriveConversationPresentation(
      [
        toolCall({ id: 'tool-1', created_at: '2026-03-16T10:00:00Z' }),
        {
          kind: 'service',
          id: 'service-1',
          level: 'info',
          message: 'hook fired',
          created_at: '2026-03-16T10:00:01Z',
        },
        toolCall({ id: 'tool-2', created_at: '2026-03-16T10:00:02Z' }),
        {
          kind: 'interactive_request',
          id: 'approval-1',
          request: {
            request_id: 'approval-1',
            workspace_id: 'workspace-1',
            thread_id: 'thread-1',
            method: 'item/commandExecution/requestApproval',
            kind: 'approval',
            title: 'Allow Read?',
            detail: '{"file_path":"/tmp/x"}',
            command: null,
            path: null,
            turn_id: null,
            item_id: null,
            questions: [],
            created_at: '2026-03-16T10:00:03Z',
          },
          resolved: true,
          created_at: '2026-03-16T10:00:03Z',
        },
        toolCall({ id: 'tool-3', created_at: '2026-03-16T10:00:04Z' }),
      ],
      collapsed,
    )

    const workSessions = presentation.history_blocks.filter(
      (block) => block.kind === 'work_session',
    )
    expect(workSessions).toHaveLength(1)
    expect(workSessions[0]?.kind === 'work_session' && workSessions[0].items).toHaveLength(3)
    // Receipts still render — as quiet rows after the run, not between fragments.
    expect(
      presentation.history_blocks.filter((block) => block.kind === 'item'),
    ).toHaveLength(2)
  })

  it('still breaks the fold for assistant messages', () => {
    const presentation = deriveConversationPresentation(
      [
        toolCall({ id: 'tool-1', created_at: '2026-03-16T10:00:00Z' }),
        {
          kind: 'assistant_message',
          id: 'assistant-1',
          text: 'Here is what I found',
          created_at: '2026-03-16T10:00:01Z',
        },
        toolCall({ id: 'tool-2', created_at: '2026-03-16T10:00:02Z' }),
      ],
      collapsed,
    )

    expect(presentation.history_blocks.map((block) => block.kind)).toEqual([
      'work_session',
      'item',
      'work_session',
    ])
  })

  it('keeps the tail session live while a trailing thought streams', () => {
    const items: ConversationItem[] = [
      toolCall({ id: 'tool-1' }),
      {
        kind: 'reasoning',
        id: 'reasoning-1',
        summary: 'Deciding next step',
        content: 'The tools are done; considering the reply.',
        created_at: '2026-03-16T10:00:02Z',
      },
    ]

    const streaming = deriveConversationPresentation(items, collapsed, { is_streaming: true })
    const tail = streaming.history_blocks.at(-1)
    if (tail?.kind !== 'work_session') throw new Error('expected a work session tail')
    // Every tool has settled, but the turn has not: the session must stay
    // running or the thread renders with zero live indicators.
    expect(tail.running).toBe(true)
    expect(tail.completed_at).toBeNull()

    const settled = deriveConversationPresentation(items, collapsed)
    const settledTail = settled.history_blocks.at(-1)
    if (settledTail?.kind !== 'work_session') throw new Error('expected a work session tail')
    expect(settledTail.running).toBe(false)
  })

  it('leaves sessions that end in tool calls alone when streaming', () => {
    const presentation = deriveConversationPresentation(
      [toolCall({ id: 'tool-1' })],
      collapsed,
      { is_streaming: true },
    )

    const tail = presentation.history_blocks.at(-1)
    if (tail?.kind !== 'work_session') throw new Error('expected a work session tail')
    expect(tail.running).toBe(false)
  })
})
