import React from 'react'
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
  it('filters reasoning and unresolved interactive requests while preserving tool summaries', () => {
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
    ] satisfies ConversationItem[])
    sessionStoreMock.mockReturnValue({
      snapshot: {
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
      'tool_summary',
      'item',
    ])
    expect(result[0]?.id).toBe('assistant_message:assistant-1')
    expect(result[1]?.id).toBe('tool-summary:tool-1:1')
    expect(result[2]?.id).toBe('interactive_request:request-2')
  })
})
