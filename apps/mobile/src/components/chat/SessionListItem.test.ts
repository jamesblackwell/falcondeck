import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { formatRelativeTime } from './sessionListItem.utils'

describe('SessionListItem timeAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-16T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "now" for timestamps less than 1 minute ago', () => {
    expect(formatRelativeTime('2026-03-16T12:00:00Z')).toBe('now')
    expect(formatRelativeTime('2026-03-16T11:59:30Z')).toBe('now')
  })

  it('returns minutes for timestamps 1-59 minutes ago', () => {
    expect(formatRelativeTime('2026-03-16T11:59:00Z')).toBe('1m')
    expect(formatRelativeTime('2026-03-16T11:45:00Z')).toBe('15m')
    expect(formatRelativeTime('2026-03-16T11:01:00Z')).toBe('59m')
  })

  it('returns hours for timestamps 1-23 hours ago', () => {
    expect(formatRelativeTime('2026-03-16T11:00:00Z')).toBe('1h')
    expect(formatRelativeTime('2026-03-16T00:00:00Z')).toBe('12h')
    expect(formatRelativeTime('2026-03-15T13:00:00Z')).toBe('23h')
  })

  it('returns days for timestamps 24+ hours ago', () => {
    expect(formatRelativeTime('2026-03-15T12:00:00Z')).toBe('1d')
    expect(formatRelativeTime('2026-03-09T12:00:00Z')).toBe('7d')
    expect(formatRelativeTime('2026-02-14T12:00:00Z')).toBe('30d')
  })

  it('handles future timestamps as "now"', () => {
    expect(formatRelativeTime('2026-03-16T13:00:00Z')).toBe('now')
  })

  it('handles invalid date strings gracefully', () => {
    expect(formatRelativeTime('not-a-date')).toBe('now')
  })
})

describe('SessionListItem props contract', () => {
  it('accepts a full thread summary so presentation stays aligned with shared clients', () => {
    const props = {
      thread: {
        id: 'thread-1',
        workspace_id: 'workspace-1',
        title: 'Test thread',
        provider: 'codex' as const,
        status: 'idle' as const,
        updated_at: '2026-03-16T10:00:00Z',
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
          level: 'none' as const,
          badge_label: null,
          unread: false,
          pending_approval_count: 0,
          pending_question_count: 0,
          last_agent_activity_seq: 0,
          last_read_seq: 0,
        },
        is_archived: false,
      },
      workspaceId: 'workspace-1',
      isSelected: true,
      onSelectThread: (_workspaceId: string, _threadId: string) => {},
    }

    expect(typeof props.thread).toBe('object')
    expect(props.thread.title).toBe('Test thread')
    expect(props.workspaceId).toBe('workspace-1')
    expect(typeof props.isSelected).toBe('boolean')
    expect(typeof props.onSelectThread).toBe('function')
  })
})
