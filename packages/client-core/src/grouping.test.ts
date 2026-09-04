import { describe, expect, it } from 'vitest'

import type { ThreadSummary, WorkspaceSummary } from './types'
import {
  buildProjectGroups,
  compareThreads,
  partitionSidebarThreads,
  sortProjectGroupThreads,
} from './grouping'

function workspace(id: string, path: string) {
  return { id, path } as WorkspaceSummary
}

function thread(id: string, workspaceId: string) {
  return { id, workspace_id: workspaceId, is_archived: false } as ThreadSummary
}

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

  it('keeps archived threads off the live list', () => {
    const live = summary({ id: 'live' })
    const archived = summary({ id: 'archived', is_archived: true, title: 'Old chat' })
    const groups = buildProjectGroups(
      [workspace('workspace', '/projects/alpha')],
      [live, archived],
    )

    expect(groups[0]?.threads.map(({ id }) => id)).toEqual(['live'])
    expect(groups[0]?.archivedThreads?.map(({ id }) => id)).toEqual(['archived'])
  })
})

describe('buildProjectGroups reuse', () => {
  const fullSummary = (overrides: Partial<ThreadSummary>): ThreadSummary =>
    summary({ id: 'thread', ...overrides })

  it('returns the previous groups untouched when fresh snapshot content is equal', () => {
    const previous = buildProjectGroups(
      [workspace('workspace', '/projects/alpha')],
      [fullSummary({})],
    )
    // Snapshots rebuild every summary object, so feed equivalent-but-fresh
    // inputs plus the previous build.
    const next = buildProjectGroups(
      [workspace('workspace', '/projects/alpha')],
      [{ ...fullSummary({}) }],
      [],
      previous,
    )

    expect(next).toBe(previous)
  })

  it('keeps unchanged identities and swaps only the changed thread', () => {
    const stable = fullSummary({})
    const changed = fullSummary({})
    const previous = buildProjectGroups([workspace('workspace', '/projects/alpha')], [stable, changed])

    const next = buildProjectGroups(
      [workspace('workspace', '/projects/alpha')],
      [stable, { ...changed, title: 'Renamed' }],
      [],
      previous,
    )

    expect(next).not.toBe(previous)
    expect(next[0]?.threads[0]).toBe(stable)
    expect(next[0]?.threads[1]).not.toBe(changed)
    expect(next[0]?.threads[1]?.title).toBe('Renamed')
  })

  it('keeps row identities when recency order moves a thread', () => {
    const older = fullSummary({ id: 'older', updated_at: '2026-08-12T09:00:00Z' })
    const newer = fullSummary({ id: 'newer', updated_at: '2026-08-12T11:00:00Z' })
    const previous = buildProjectGroups([workspace('workspace', '/projects/alpha')], [older, newer])

    const bumped = { ...older, updated_at: '2026-08-12T12:00:00Z' }
    const next = buildProjectGroups(
      [workspace('workspace', '/projects/alpha')],
      [bumped, newer],
      [],
      previous,
    )

    // Order moved, so the list and its container are new, but both rows keep
    // identity and the workspace stays put.
    expect(next).not.toBe(previous)
    expect(next[0]).not.toBe(previous[0])
    expect(next[0]?.threads.map(({ id }) => id)).toEqual(['older', 'newer'])
    expect(next[0]?.threads[0]).toBe(bumped)
    expect(next[0]?.threads[1]).toBe(newer)
    expect(next[0]?.workspace).toBe(previous[0]?.workspace)
  })

  it('still rebuilds everything without a previous build', () => {
    const inputs = () => [workspace('workspace', '/projects/alpha')]
    const first = buildProjectGroups(inputs(), [fullSummary({})])
    const second = buildProjectGroups([...inputs()], [{ ...fullSummary({}) }])

    expect(second).not.toBe(first)
    expect(second[0]).not.toBe(first[0])
  })

  it('detects nested attention changes on an otherwise identical summary', () => {
    const before = fullSummary({
      attention: {
        level: 'none',
        badge_label: null,
        unread: false,
        pending_approval_count: 0,
        pending_question_count: 0,
        last_agent_activity_seq: 1,
        last_read_seq: 1,
      },
    })
    const previous = buildProjectGroups([workspace('workspace', '/projects/alpha')], [before])

    const after = {
      ...before,
      attention: { ...before.attention, last_read_seq: 2, unread: false },
    }
    const next = buildProjectGroups(
      [workspace('workspace', '/projects/alpha')],
      [after],
      [],
      previous,
    )

    expect(next[0]?.threads[0]).toBe(after)
    expect(next[0]?.threads[0]).not.toBe(before)
  })
})

describe('compareThreads', () => {
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

describe('sortProjectGroupThreads', () => {
  it('reorders chats inside each project without moving the projects', () => {
    const older = summary({
      id: 'older',
      title: 'Alpha',
      updated_at: '2026-08-12T09:00:00Z',
    })
    const newer = summary({
      id: 'newer',
      title: 'Zebra',
      updated_at: '2026-08-12T11:00:00Z',
    })
    const groups = [
      {
        workspace: workspace('workspace', '/projects/alpha'),
        threads: [older, newer],
      },
    ]

    expect(
      sortProjectGroupThreads(groups, 'last_updated')[0]?.threads.map(({ id }) => id),
    ).toEqual(['newer', 'older'])
    expect(
      sortProjectGroupThreads(groups, 'alphabetical')[0]?.threads.map(({ id }) => id),
    ).toEqual(['older', 'newer'])
  })

  it('keeps project pins above ordinary chats and global pins above both', () => {
    const older = summary({
      id: 'older',
      title: 'Alpha',
      updated_at: '2026-08-12T09:00:00Z',
    })
    const projectPinned = summary({
      id: 'project-pinned',
      title: 'Zebra',
      is_pinned_in_project: true,
      updated_at: '2026-08-12T08:00:00Z',
    })
    const globallyPinned = summary({
      id: 'globally-pinned',
      title: 'Beta',
      is_pinned: true,
      updated_at: '2026-08-12T07:00:00Z',
    })
    const groups = [
      {
        workspace: workspace('workspace', '/projects/alpha'),
        threads: [older, projectPinned, globallyPinned],
      },
    ]

    expect(
      sortProjectGroupThreads(groups, 'last_updated')[0]?.threads.map(({ id }) => id),
    ).toEqual(['globally-pinned', 'project-pinned', 'older'])
  })
})

describe('partitionSidebarThreads', () => {
  it('treats a global pin as leaving the project list', () => {
    const globallyPinned = summary({ id: 'global', is_pinned: true, is_pinned_in_project: true })
    const projectPinned = summary({ id: 'project', is_pinned_in_project: true })
    const ordinary = summary({ id: 'ordinary' })

    expect(partitionSidebarThreads([globallyPinned, projectPinned, ordinary])).toEqual({
      globallyPinned: [globallyPinned],
      pinnedInProject: [projectPinned],
      unpinned: [ordinary],
      archived: [],
    })
  })

  it('splits archived chats out of the pin buckets', () => {
    const archived = summary({ id: 'archived', is_archived: true, is_pinned: true })
    expect(partitionSidebarThreads([archived]).archived).toEqual([archived])
    expect(partitionSidebarThreads([archived]).globallyPinned).toEqual([])
  })
})
