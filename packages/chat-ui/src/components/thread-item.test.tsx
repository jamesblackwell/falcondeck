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

describe('ThreadItem background activity', () => {
  /** The turn parked but the work it started has not: without this mark the
   *  row is indistinguishable from a finished thread, and the agent starts
   *  talking again out of nowhere. */
  it('marks an idle thread whose background work is still running', () => {
    const base = thread('2026-08-31T14:08:59Z')
    render(
      <ThreadItem
        thread={{
          ...base,
          attention: { ...base.attention, background_task_count: 1 },
        }}
        workspaceId="workspace-1"
        isSelected={false}
        onSelect={() => {}}
      />,
    )

    expect(
      screen.getByRole('img', { name: 'Background task still running' }),
    ).toBeInTheDocument()
  })

  it('says nothing when no background work is outstanding', () => {
    render(
      <ThreadItem
        thread={thread('2026-08-31T14:08:59Z')}
        workspaceId="workspace-1"
        isSelected={false}
        onSelect={() => {}}
      />,
    )

    expect(
      screen.queryByRole('img', { name: /Background task/ }),
    ).not.toBeInTheDocument()
  })
})
