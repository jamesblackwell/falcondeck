import { describe, expect, it } from 'vitest'

import type { ThreadSummary } from './types'
import { wasTurnInterruptedByShutdown } from './thread-attention'

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: 'thread-1',
    workspace_id: 'workspace-1',
    title: 'Thread',
    provider: 'codex',
    status: 'idle',
    updated_at: '2026-08-12T10:00:00Z',
    last_message_preview: null,
    latest_turn_id: null,
    latest_plan: null,
    latest_diff: null,
    last_tool: null,
    last_error: null,
    agent: {
      model_id: null,
      reasoning_effort: null,
      collaboration_mode_id: null,
      approval_policy: null,
      service_tier: null,
    },
    attention: {
      level: 'none',
      badge_label: null,
      unread: false,
      pending_approval_count: 0,
      pending_question_count: 0,
      last_agent_activity_seq: 0,
      last_read_seq: 0,
    },
    is_archived: false,
    is_pinned: false,
    goal: null,
    queued_turns: [],
    variant: null,
    ...overrides,
  }
}

describe('wasTurnInterruptedByShutdown', () => {
  it('only identifies the persisted shutdown interruption error', () => {
    expect(
      wasTurnInterruptedByShutdown(
        thread({
          status: 'error',
          last_error: 'FalconDeck was closed while this turn was running',
        }),
      ),
    ).toBe(true)
    expect(
      wasTurnInterruptedByShutdown(
        thread({ status: 'error', last_error: 'Provider disconnected' }),
      ),
    ).toBe(false)
  })
})
