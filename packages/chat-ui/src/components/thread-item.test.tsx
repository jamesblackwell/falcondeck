import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ThreadSummary } from '@falcondeck/client-core'

import { formatThreadTimestamp, ThreadItem } from './thread-item'

function thread(updatedAt: string): ThreadSummary {
  return {
    id: 'thread-1',
    workspace_id: 'workspace-1',
    title: 'Timestamped task',
    provider: 'codex',
    status: 'idle',
    updated_at: updatedAt,
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
  } as ThreadSummary
}

describe('ThreadItem timestamp', () => {
  afterEach(() => vi.useRealTimers())

  it('exposes a friendly exact timestamp on the relative time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02T10:00:00Z'))
    render(
      <ThreadItem
        thread={thread('2026-08-31T14:08:59Z')}
        workspaceId="workspace-1"
        isSelected={false}
        onSelect={() => {}}
      />,
    )

    const timestamp = screen.getByText('1d')
    expect(timestamp.tagName).toBe('TIME')
    expect(timestamp).toHaveAttribute('datetime', '2026-08-31T14:08:59Z')
    expect(timestamp.getAttribute('title')).toMatch(/August 31|31 August/)
    expect(timestamp.getAttribute('title')).not.toContain('2026')
  })

  it('includes the year for timestamps outside the current year', () => {
    expect(
      formatThreadTimestamp(
        '2025-12-20T14:08:59Z',
        new Date('2026-09-02T10:00:00Z'),
      ),
    ).toContain('2025')
  })
})
