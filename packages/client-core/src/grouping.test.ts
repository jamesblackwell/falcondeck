import { describe, expect, it } from 'vitest'

import type { ThreadSummary, WorkspaceSummary } from './types'
import { buildProjectGroups, compareThreads } from './grouping'

function workspace(id: string, path: string) {
  return { id, path } as WorkspaceSummary
}

function thread(id: string, workspaceId: string) {
  return { id, workspace_id: workspaceId, is_archived: false } as ThreadSummary
}

describe('buildProjectGroups', () => {
  it('keeps saved projects first and falls back alphabetically for new projects', () => {
    const groups = buildProjectGroups(
      [
        workspace('new', '/projects/zeta'),
        workspace('saved-b', '/projects/beta'),
        workspace('saved-a', '/projects/alpha'),
      ],
      [thread('thread-a', 'saved-a')],
      ['saved-a', 'saved-b'],
    )

    expect(groups.map((group) => group.workspace.id)).toEqual(['saved-a', 'saved-b', 'new'])
  })
})

describe('compareThreads', () => {
  const summary = (overrides: Partial<ThreadSummary>): ThreadSummary =>
    ({
      id: 'thread',
      workspace_id: 'workspace',
      title: 'Chat',
      status: 'idle',
      updated_at: '2026-08-12T12:00:00Z',
      attention: {
        level: 'none',
        badge_label: null,
        unread: false,
        pending_approval_count: 0,
        pending_question_count: 0,
        last_agent_activity_seq: 0,
        last_read_seq: 0,
      },
      ...overrides,
    }) as ThreadSummary

  it('uses the work-queue bucket order', () => {
    const unread = summary({
      id: 'unread',
      updated_at: '2026-08-12T08:00:00Z',
      attention: {
        level: 'unread',
        badge_label: null,
        unread: true,
        pending_approval_count: 0,
        pending_question_count: 0,
        last_agent_activity_seq: 1,
        last_read_seq: 0,
      },
    })
    const running = summary({ id: 'running', status: 'running' })
    const awaitingResponse = summary({
      id: 'awaiting-response',
      attention: {
        level: 'awaiting_response',
        badge_label: 'Awaiting response',
        unread: false,
        pending_approval_count: 1,
        pending_question_count: 0,
        last_agent_activity_seq: 0,
        last_read_seq: 0,
      },
    })

    expect([running, awaitingResponse, unread].sort(compareThreads('priority')).map(({ id }) => id))
      .toEqual(['awaiting-response', 'unread', 'running'])
  })

  it('keeps actionable status ordering within the unread bucket', () => {
    const ordinaryUnread = summary({
      id: 'ordinary-unread',
      updated_at: '2026-08-12T11:00:00Z',
      attention: {
        level: 'unread',
        badge_label: null,
        unread: true,
        pending_approval_count: 0,
        pending_question_count: 0,
        last_agent_activity_seq: 2,
        last_read_seq: 1,
      },
    })
    const unreadAwaitingResponse = summary({
      id: 'unread-awaiting-response',
      updated_at: '2026-08-12T09:00:00Z',
      attention: {
        level: 'awaiting_response',
        badge_label: 'Awaiting response',
        unread: true,
        pending_approval_count: 1,
        pending_question_count: 0,
        last_agent_activity_seq: 2,
        last_read_seq: 1,
      },
    })

    expect(
      [ordinaryUnread, unreadAwaitingResponse]
        .sort(compareThreads('priority'))
        .map(({ id }) => id),
    ).toEqual(['unread-awaiting-response', 'ordinary-unread'])
  })

  it('uses recency to seed order within a priority bucket', () => {
    const alpha = summary({
      id: 'alpha',
      title: 'Alpha',
      status: 'running',
      updated_at: '2026-08-12T09:00:00Z',
    })
    const zulu = summary({
      id: 'zulu',
      title: 'Zulu',
      status: 'running',
      updated_at: '2026-08-12T10:00:00Z',
    })
    const compare = compareThreads('priority')

    expect([zulu, alpha].sort(compare).map(({ id }) => id)).toEqual(['zulu', 'alpha'])

    alpha.updated_at = '2026-08-12T11:00:00Z'
    expect([zulu, alpha].sort(compare).map(({ id }) => id)).toEqual(['alpha', 'zulu'])
  })

  it('keeps alphabetical ties stable when activity timestamps change', () => {
    const first = summary({ id: 'a', title: 'Same', updated_at: '2026-08-12T09:00:00Z' })
    const second = summary({ id: 'b', title: 'Same', updated_at: '2026-08-12T10:00:00Z' })
    const compare = compareThreads('alphabetical')

    expect([second, first].sort(compare).map(({ id }) => id)).toEqual(['a', 'b'])
    first.updated_at = '2026-08-12T11:00:00Z'
    expect([second, first].sort(compare).map(({ id }) => id)).toEqual(['a', 'b'])
  })
})
