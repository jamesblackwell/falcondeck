import { fireEvent, render, screen } from '@testing-library/react'
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

describe('ThreadItem agent origin', () => {
  it('shows the agent marker beside the isolated-copy marker', () => {
    render(
      <ThreadItem
        thread={{
          ...thread('2026-08-31T14:08:59Z'),
          origin: { kind: 'agent_spawn', parent_thread_id: 'parent-1' },
          variant: {
            slug: 'child-task',
            path: '/tmp/child-task',
            branch: 'fd/child-task',
            kind: 'worktree',
          },
        }}
        workspaceId="workspace-1"
        isSelected={false}
        onSelect={() => {}}
      />,
    )

    const marker = screen.getByRole('img', { name: 'Created by an agent' })
    expect(marker).toHaveAttribute('title', 'Created by an agent')
    expect(marker.nextElementSibling).toBe(
      screen.getByRole('img', { name: 'Isolated copy' }),
    )
  })

  it('redraws the connector when nesting changes and nothing else does', () => {
    const spawned = {
      ...thread('2026-08-31T14:08:59Z'),
      origin: { kind: 'agent_spawn', parent_thread_id: 'parent-1' },
    } as ThreadSummary
    // Every other prop keeps its identity, so the row only repaints if the
    // memo comparator weighs the rung itself. Archiving a sibling or a parent
    // re-cuts the connector exactly like this.
    const onSelect = vi.fn()
    const renderRow = (depth: number, trunkMask = 0) => (
      <ThreadItem
        thread={spawned}
        workspaceId="workspace-1"
        isSelected={false}
        onSelect={onSelect}
        depth={depth}
        trunkMask={trunkMask}
      />
    )
    const trunks = () =>
      screen.getByTestId('thread-nesting-connector').childElementCount
    const { rerender } = render(renderRow(0))
    expect(screen.getByRole('img', { name: 'Created by an agent' })).toBeInTheDocument()
    expect(screen.queryByTestId('thread-nesting-connector')).not.toBeInTheDocument()

    // Nested, with a sibling still below: the elbow plus the upright to it.
    rerender(renderRow(1, 0b1))
    expect(screen.queryByRole('img', { name: 'Created by an agent' })).not.toBeInTheDocument()
    expect(trunks()).toBe(2)
    expect(
      screen.getByRole('button', { name: /Started by the chat above/ }),
    ).toBeInTheDocument()

    // That sibling goes away: the upright below the elbow goes with it.
    rerender(renderRow(1))
    expect(trunks()).toBe(1)

    // The parent goes away: back to a plain row with the agent marker.
    rerender(renderRow(0))
    expect(screen.queryByTestId('thread-nesting-connector')).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Created by an agent' })).toBeInTheDocument()
  })

  it('refreshes the marker when the daemon adds or changes the origin', () => {
    const base = thread('2026-08-31T14:08:59Z')
    const onSelect = vi.fn()
    const renderRow = (value: ThreadSummary) => (
      <ThreadItem
        thread={value}
        workspaceId="workspace-1"
        isSelected={false}
        onSelect={onSelect}
      />
    )
    const { rerender } = render(renderRow(base))
    expect(screen.queryByRole('img', { name: 'Created by an agent' })).not.toBeInTheDocument()

    rerender(renderRow({
      ...base,
      origin: { kind: 'agent_spawn', parent_thread_id: 'parent-1' },
    }))
    expect(screen.getByRole('img', { name: 'Created by an agent' })).toBeInTheDocument()

    rerender(renderRow({
      ...base,
      origin: { kind: 'automation', automation_id: 'automation-1', name: 'Daily check' },
    }))
    expect(screen.queryByRole('img', { name: 'Created by an agent' })).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Automation: Daily check' })).toBeInTheDocument()
  })
})

describe('ThreadItem archive actions', () => {
  it('offers unarchive on an archived row instead of archive', () => {
    const onUnarchive = vi.fn()
    render(
      <ThreadItem
        thread={{ ...thread('2026-08-31T14:08:59Z'), is_archived: true }}
        workspaceId="workspace-1"
        isSelected={false}
        onSelect={() => {}}
        onArchive={() => {}}
        onUnarchive={onUnarchive}
      />,
    )

    expect(
      screen.queryByRole('button', { name: /Archive thread/, hidden: true }),
    ).not.toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Unarchive thread Timestamped task',
        hidden: true,
      }),
    )
    expect(onUnarchive).toHaveBeenCalledWith('workspace-1', 'thread-1')
  })
})

describe('ThreadItem background activity', () => {
  it('spins while background work is still running', () => {
    const base = thread('2026-08-31T14:08:59Z')
    const { container } = render(
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

    expect(container.querySelector('.animate-diamond-activity')).not.toBeNull()
    expect(container.querySelector('.bg-unread')).toBeNull()
  })

  it('spins over the unread dot until the background work reports', () => {
    const base = thread('2026-08-31T14:08:59Z')
    const { container } = render(
      <ThreadItem
        thread={{
          ...base,
          attention: {
            ...base.attention,
            unread: true,
            last_agent_activity_seq: 4,
            last_read_seq: 1,
            background_task_count: 1,
          },
        }}
        workspaceId="workspace-1"
        isSelected={false}
        onSelect={() => {}}
      />,
    )

    expect(container.querySelector('.animate-diamond-activity')).not.toBeNull()
    expect(container.querySelector('.bg-unread')).toBeNull()
  })
})
