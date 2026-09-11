import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'

import { formatRelativeTime } from './sessionListItem.utils'
import { SessionListItem } from './SessionListItem'
import { cleanup, renderComponent } from '../../test/render'
import { thread } from '../../test/factories'

describe('SessionListItem timeAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-16T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
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
  it('opens thread options from a long press', () => {
    const onOpenThreadOptions = vi.fn()
    const item = thread({ id: 'thread-1', workspace_id: 'workspace-1' })
    const renderer = renderComponent(React.createElement(SessionListItem, {
      thread: item,
      workspaceId: 'workspace-1',
      isSelected: false,
      onSelectThread: vi.fn(),
      onOpenThreadOptions,
    }))

    renderer.root.findByProps({
      accessibilityHint: 'Double tap and hold for thread options',
    }).props.onLongPress()

    expect(onOpenThreadOptions).toHaveBeenCalledWith('workspace-1', item)
  })

  it('uses the quiet supporting treatment for thread titles', () => {
    const renderer = renderComponent(React.createElement(SessionListItem, {
      thread: thread({ id: 'thread-1', workspace_id: 'workspace-1', title: 'Quiet title' }),
      workspaceId: 'workspace-1',
      isSelected: false,
      onSelectThread: vi.fn(),
    }))
    const title = renderer.root.find(
      (node) => String(node.type) === 'Text' && node.children.includes('Quiet title'),
    )
    const style = Object.assign({}, ...title.props.style.filter(Boolean))

    expect(style).toMatchObject({
      color: '#ccc',
      fontFamily: 'Geist',
      fontSize: 14,
      fontWeight: '400',
      lineHeight: 21,
    })
  })

  it('marks a project-pinned thread in the row', () => {
    const renderer = renderComponent(React.createElement(SessionListItem, {
      thread: thread({
        id: 'thread-1',
        workspace_id: 'workspace-1',
        title: 'Project pinned',
        is_pinned_in_project: true,
      }),
      workspaceId: 'workspace-1',
      isSelected: false,
      onSelectThread: vi.fn(),
    }))

    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Pinned in project' }),
    ).toBeTruthy()
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Pinned' })).toHaveLength(0)
  })

  it('labels a globally pinned thread as pinned, even if it is also pinned in the project', () => {
    const renderer = renderComponent(React.createElement(SessionListItem, {
      thread: thread({
        id: 'thread-1',
        workspace_id: 'workspace-1',
        title: 'Globally pinned',
        is_pinned: true,
        is_pinned_in_project: true,
      }),
      workspaceId: 'workspace-1',
      isSelected: false,
      onSelectThread: vi.fn(),
    }))

    expect(renderer.root.findByProps({ accessibilityLabel: 'Pinned' })).toBeTruthy()
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Pinned in project' }),
    ).toHaveLength(0)
  })

  it('hides the pin mark on an unpinned thread', () => {
    const renderer = renderComponent(React.createElement(SessionListItem, {
      thread: thread({ id: 'thread-1', workspace_id: 'workspace-1', title: 'Loose' }),
      workspaceId: 'workspace-1',
      isSelected: false,
      onSelectThread: vi.fn(),
    }))

    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Pinned' })).toHaveLength(0)
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Pinned in project' }),
    ).toHaveLength(0)
  })

  it('rotates the pin on a wrapper, not the lucide icon', () => {
    const renderer = renderComponent(React.createElement(SessionListItem, {
      thread: thread({
        id: 'thread-1',
        workspace_id: 'workspace-1',
        title: 'Globally pinned',
        is_pinned: true,
      }),
      workspaceId: 'workspace-1',
      isSelected: false,
      onSelectThread: vi.fn(),
    }))

    const mark = renderer.root.findByProps({ accessibilityLabel: 'Pinned' })
    expect(mark.props.style).toEqual({ transform: [{ rotate: '45deg' }] })

    const icon = mark.findAll((node) => node.props.size === 14)
    expect(icon).toHaveLength(1)
    expect(icon[0]?.props.style).toBeUndefined()
    expect(icon[0]?.props.color).toBe('#666')
  })

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
        is_pinned: false,
        is_pinned_in_project: false,
        goal: null,
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
