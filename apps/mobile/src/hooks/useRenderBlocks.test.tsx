import React from 'react'
import { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

import type { ConversationItem } from '@falcondeck/client-core'

const { itemsMock, sessionStoreMock } = vi.hoisted(() => ({
  itemsMock: vi.fn(),
  sessionStoreMock: vi.fn(),
}))

vi.mock('@/store', () => ({
  useConversationItems: () => itemsMock(),
  useSessionStore: (selector: (state: any) => unknown) =>
    selector(sessionStoreMock()),
}))

import { renderComponent } from '@/test/render'

import { useRenderBlocks } from './useRenderBlocks'

describe('useRenderBlocks', () => {
  it('keeps a trailing collapsed work session live while its thread streams', () => {
    itemsMock.mockReturnValue([
      {
        kind: 'tool_call',
        id: 'tool-1',
        title: 'Read package.json',
        tool_kind: 'read',
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
          summary_hint: null,
        },
        created_at: '2026-03-16T10:00:00Z',
        completed_at: '2026-03-16T10:00:01Z',
      },
      {
        kind: 'reasoning',
        id: 'reasoning-1',
        summary: 'Deciding next step',
        content: 'The tool is done; considering the reply.',
        lifecycle: 'streaming',
        created_at: '2026-03-16T10:00:02Z',
      },
    ] satisfies ConversationItem[])
    sessionStoreMock.mockReturnValue({
      selectedWorkspaceId: 'workspace-1',
      selectedThreadId: 'thread-1',
      snapshot: {
        threads: [
          { id: 'thread-1', workspace_id: 'workspace-1', status: 'running' },
        ],
        preferences: {
          version: 1,
          conversation: {
            tool_details_mode: 'collapsed',
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
        },
      },
    })

    let result: ReturnType<typeof useRenderBlocks> = []
    function Harness() {
      result = useRenderBlocks()
      return null
    }

    renderComponent(<Harness />)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      kind: 'work_session',
      running: true,
      completed_at: null,
    })
  })

  it('preserves completed row identities while a 1,000-item tail streams', () => {
    const items = Array.from({ length: 1_000 }, (_, index): ConversationItem =>
      index % 2 === 0
        ? {
            kind: 'user_message',
            id: `user-${index}`,
            text: `Prompt ${index}`,
            attachments: [],
            created_at: '2026-03-16T10:00:00Z',
          }
        : {
            kind: 'assistant_message',
            id: `assistant-${index}`,
            text: `Response ${index}`,
            lifecycle: index === 999 ? 'streaming' : 'complete',
            created_at: '2026-03-16T10:00:00Z',
          },
    )
    itemsMock.mockReturnValue(items)
    sessionStoreMock.mockReturnValue({ snapshot: null })
    let result: ReturnType<typeof useRenderBlocks> = []

    function Harness() {
      result = useRenderBlocks()
      return null
    }

    const renderer = renderComponent(<Harness />)
    const first = result
    const tail = items.at(-1) as Extract<ConversationItem, { kind: 'assistant_message' }>
    itemsMock.mockReturnValue([...items.slice(0, -1), { ...tail, text: `${tail.text} token` }])

    act(() => renderer.update(<Harness />))

    expect(result).toHaveLength(1_000)
    for (let index = 0; index < 999; index += 1) {
      expect(result[index]).toBe(first[index])
    }
    expect(result[999]).not.toBe(first[999])
  })

  it('keeps resolved receipts but pins every unresolved interaction outside history', () => {
    let result: ReturnType<typeof useRenderBlocks> = []

    itemsMock.mockReturnValue([
      {
        kind: 'assistant_message',
        id: 'assistant-1',
        text: 'Hello there',
        created_at: '2026-03-16T10:00:00Z',
      },
      {
        kind: 'reasoning',
        id: 'reasoning-1',
        summary: null,
        content: 'Thinking...',
        created_at: '2026-03-16T10:00:01Z',
      },
      {
        kind: 'tool_call',
        id: 'tool-1',
        title: 'Read package.json',
        tool_kind: 'read',
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
          summary_hint: null,
        },
        created_at: '2026-03-16T10:00:02Z',
        completed_at: '2026-03-16T10:00:03Z',
      },
      {
        kind: 'interactive_request',
        id: 'request-1',
        request: {
          request_id: 'request-1',
          workspace_id: 'workspace-1',
          thread_id: 'thread-1',
          method: 'approval',
          kind: 'approval',
          title: 'Approve command',
          detail: null,
          command: 'npm test',
          path: '/tmp/project',
          turn_id: null,
          item_id: null,
          questions: [],
          created_at: '2026-03-16T10:00:04Z',
        },
        created_at: '2026-03-16T10:00:04Z',
        resolved: false,
      },
      {
        kind: 'interactive_request',
        id: 'request-2',
        request: {
          request_id: 'request-2',
          workspace_id: 'workspace-1',
          thread_id: 'thread-1',
          method: 'approval',
          kind: 'approval',
          title: 'Approved command',
          detail: null,
          command: 'npm test',
          path: '/tmp/project',
          turn_id: null,
          item_id: null,
          questions: [],
          created_at: '2026-03-16T10:00:05Z',
        },
        created_at: '2026-03-16T10:00:05Z',
        resolved: true,
      },
      {
        kind: 'interactive_request',
        id: 'question-1',
        request: {
          request_id: 'question-1',
          workspace_id: 'workspace-1',
          thread_id: 'thread-1',
          method: 'item/tool/requestUserInput',
          kind: 'question',
          title: 'Choose a framework',
          detail: null,
          command: null,
          path: null,
          turn_id: 'turn-1',
          item_id: 'item-1',
          questions: [{
            id: 'framework', header: 'Framework', question: 'Which framework?',
            is_other: false, is_secret: false, options: null,
          }],
          created_at: '2026-03-16T10:00:06Z',
        },
        created_at: '2026-03-16T10:00:06Z',
        resolved: false,
      },
    ] satisfies ConversationItem[])
    sessionStoreMock.mockReturnValue({
      selectedThreadId: null,
      snapshot: {
        threads: [],
        preferences: {
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
        },
      },
    })

    function Harness() {
      result = useRenderBlocks()
      return null
    }

    renderComponent(<Harness />)

    expect(result.map((block) => block.kind)).toEqual([
      'item',
      'item',
      'tool_summary',
      'item',
    ])
    expect(result[0]?.id).toBe('assistant_message:assistant-1')
    // Reasoning used to be filtered out here, which made it unreachable in the
    // app. It now reaches the router, which renders it collapsed.
    expect(result[1]?.id).toBe('reasoning:reasoning-1')
    expect(result[2]?.id).toBe('tool-summary:tool-1')
    expect(result[3]?.id).toBe('interactive_request:request-2')
    expect(result.some((block) => block.id === 'interactive_request:request-1')).toBe(false)
    expect(result.some((block) => block.id === 'interactive_request:question-1')).toBe(false)
  })
})
