import { describe, expect, it } from 'vitest'

import type { InteractiveRequest, ThreadSummary } from './types'
import {
  deriveThreadAttentionPresentation,
  summarizeThreadAttention,
  wasTurnInterruptedByShutdown,
} from './thread-attention'

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
    is_pinned_in_project: false,
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

describe('summarizeThreadAttention', () => {
  it('counts running and waiting threads and skips settled ones', () => {
    const summary = summarizeThreadAttention([
      thread({ id: 'a', status: 'running' }),
      thread({ id: 'b', status: 'running' }),
      thread({
        id: 'c',
        attention: {
          ...thread().attention,
          last_agent_activity_seq: 4,
          last_read_seq: 1,
        },
      }),
      thread({ id: 'd' }),
    ])
    expect(summary).toEqual({ running: 2, unread: 1, unreadTone: 'info' })
  })

  it('leaves a read failure out of the count', () => {
    expect(
      summarizeThreadAttention([
        thread({ id: 'a', status: 'error', last_error: 'boom' }),
      ]),
    ).toEqual({ running: 0, unread: 0, unreadTone: 'info' })
  })

  it('escalates the tone for unseen failures and pending questions', () => {
    const awaiting = summarizeThreadAttention([
      thread({
        id: 'a',
        attention: { ...thread().attention, pending_question_count: 1 },
      }),
    ])
    expect(awaiting).toEqual({ running: 0, unread: 1, unreadTone: 'warning' })

    const failed = summarizeThreadAttention([
      thread({
        id: 'a',
        status: 'error',
        attention: { ...thread().attention, unread: true },
      }),
      thread({
        id: 'b',
        attention: { ...thread().attention, pending_approval_count: 1 },
      }),
    ])
    expect(failed).toEqual({ running: 0, unread: 2, unreadTone: 'danger' })
  })
})

describe('background activity', () => {
  it('does not treat leftover background work as a live turn', () => {
    const presentation = deriveThreadAttentionPresentation(
      thread({
        status: 'idle',
        attention: {
          level: 'unread',
          badge_label: null,
          unread: true,
          pending_approval_count: 0,
          pending_question_count: 0,
          background_task_count: 2,
          last_agent_activity_seq: 4,
          last_read_seq: 1,
        },
      }),
    )

    expect(presentation.showSpinner).toBe(false)
    expect(presentation.level).toBe('unread')
    expect(presentation.showUnreadDot).toBe(true)
  })

  it('keeps the running spinner when the turn itself is live', () => {
    const presentation = deriveThreadAttentionPresentation(
      thread({
        status: 'running',
        attention: {
          level: 'running',
          badge_label: null,
          unread: false,
          pending_approval_count: 0,
          pending_question_count: 0,
          background_task_count: 1,
          last_agent_activity_seq: 4,
          last_read_seq: 4,
        },
      }),
    )

    expect(presentation.showSpinner).toBe(true)
    expect(presentation.showUnreadDot).toBe(false)
  })
})

describe('pending requests missing from the summary', () => {
  const planApproval = {
    request_id: 'plan-1',
    workspace_id: 'workspace-1',
    thread_id: 'thread-1',
    method: 'x.ai/exit_plan_mode',
    kind: 'plan_approval',
    approval_decisions: [],
    title: 'Review implementation plan',
    detail: null,
    command: null,
    path: null,
    turn_id: null,
    item_id: null,
    questions: [],
    created_at: '2026-08-12T10:00:00Z',
  } satisfies InteractiveRequest

  it('treats a plan approval as awaiting a response', () => {
    const presentation = deriveThreadAttentionPresentation(thread(), [planApproval])
    expect(presentation.pendingApprovalCount).toBe(1)
    expect(presentation.level).toBe('awaiting_response')
    expect(presentation.showBadge).toBe(true)
  })

  it('does not borrow a plan approval from another thread', () => {
    const presentation = deriveThreadAttentionPresentation(thread({ id: 'thread-2' }), [
      planApproval,
    ])
    expect(presentation.pendingApprovalCount).toBe(0)
    expect(presentation.level).toBe('none')
  })

  it('does not borrow a plan approval from another workspace', () => {
    const presentation = deriveThreadAttentionPresentation(
      thread({ workspace_id: 'workspace-2' }),
      [planApproval],
    )
    expect(presentation.pendingApprovalCount).toBe(0)
    expect(presentation.level).toBe('none')
  })
})
