import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ActiveSubagent, ThreadSummary } from '@falcondeck/client-core'

import { SessionHeader } from './session-header'
import { formatSubagentElapsed } from './subagent-activity'
import { ThreadItem } from './thread-item'

const agent = (id: string, label: string, extra: Partial<ActiveSubagent> = {}): ActiveSubagent => ({
  id,
  label,
  started_at: new Date(Date.now() - 90_000).toISOString(),
  ...extra,
})

function thread(active_subagents: ActiveSubagent[]): ThreadSummary {
  return {
    id: 'thread-1',
    workspace_id: 'workspace-1',
    title: 'Parent task',
    provider: 'claude',
    status: 'running',
    updated_at: new Date().toISOString(),
    attention: {
      level: 'none',
      badge_label: null,
      unread: false,
      pending_approval_count: 0,
      pending_question_count: 0,
      active_subagents,
      last_agent_activity_seq: 0,
      last_read_seq: 0,
    },
    is_archived: false,
    is_pinned: false,
    is_pinned_in_project: false,
  } as ThreadSummary
}

describe('sub-agent activity', () => {
  it('lists running sub-agents under the sidebar row and collapses the overflow', () => {
    render(
      <ThreadItem
        thread={thread([
          agent('a', 'Find relay retries', { agent_type: 'Explore' }),
          agent('b', 'Review diff'),
          agent('c', 'Check tests'),
          agent('d', 'Audit docs', { background: true }),
        ])}
        workspaceId="workspace-1"
        isSelected={false}
        onSelect={() => {}}
      />,
    )
    const list = screen.getByRole('list', { name: '4 running sub-agents' })
    expect(list).toHaveTextContent('Find relay retries')
    expect(list).toHaveTextContent('Explore')
    expect(list).toHaveTextContent('1m')
    expect(list).toHaveTextContent('+1 more')
    expect(list).not.toHaveTextContent('Audit docs')
  })

  it('renders no list when nothing is running', () => {
    render(
      <ThreadItem thread={thread([])} workspaceId="workspace-1" isSelected={false} onSelect={() => {}} />,
    )
    expect(screen.queryByTestId('thread-subagents')).toBeNull()
  })

  it('shows a count badge in the session header', () => {
    render(<SessionHeader workspace={null} thread={thread([agent('a', 'Search'), agent('b', 'Review')])} />)
    expect(screen.getByRole('img', { name: /2 running sub-agents: Search, Review/ })).toHaveTextContent('2 agents')
  })

  it('formats elapsed time', () => {
    const now = Date.parse('2026-11-11T10:00:00Z')
    expect(formatSubagentElapsed('2026-11-11T09:59:30Z', now)).toBe('<1m')
    expect(formatSubagentElapsed('2026-11-11T09:55:00Z', now)).toBe('5m')
    expect(formatSubagentElapsed('2026-11-11T07:00:00Z', now)).toBe('3h')
  })
})
