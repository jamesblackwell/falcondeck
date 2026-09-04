import { describe, expect, it } from 'vitest'

import { workspace, thread } from '@/test/factories'

import { buildSidebarRows, sidebarRowsEqual, VISIBLE_THREAD_LIMIT } from './sidebarRows'

const emptyCollapsed = new Set<string>()
const defaultCounts = new Map<string, number>()

describe('buildSidebarRows', () => {
  it('creates workspace and thread rows in order', () => {
    const rows = buildSidebarRows(
      [
        {
          workspace: workspace({ id: 'w1', path: '/tmp/project-one' }),
          threads: [
            thread({ id: 't1', workspace_id: 'w1' }),
            thread({ id: 't2', workspace_id: 'w1' }),
          ],
        },
      ],
      emptyCollapsed,
      defaultCounts,
      null,
    )

    expect(rows).toEqual([
      {
        key: 'section:projects',
        type: 'section',
        title: 'Projects',
      },
      {
        key: 'workspace:w1',
        type: 'workspace',
        workspaceId: 'w1',
        workspaceName: 'project-one',
        isOpen: true,
        runningCount: 0,
        unreadCount: 0,
        unreadTone: 'info',
      },
      expect.objectContaining({
        key: 'thread:t1',
        type: 'thread',
        workspaceId: 'w1',
      }),
      expect.objectContaining({
        key: 'thread:t2',
        type: 'thread',
        workspaceId: 'w1',
      }),
    ])
  })

  it('renders casual chats flat below projects', () => {
    const rows = buildSidebarRows(
      [
        {
          workspace: workspace({ id: 'chat-w', kind: 'casual' }),
          threads: [thread({ id: 'chat-t', workspace_id: 'chat-w', title: 'Weekend plans' })],
        },
        {
          workspace: workspace({ id: 'project-w', kind: 'project', path: '/tmp/project' }),
          threads: [thread({ id: 'project-t', workspace_id: 'project-w' })],
        },
      ],
      emptyCollapsed,
      defaultCounts,
      null,
    )

    expect(rows.map((row) => row.key)).toEqual([
      'section:projects',
      'workspace:project-w',
      'thread:project-t',
      'section:chats',
      'chat:chat-w:chat-t',
    ])
  })

  it('keeps chat rows for a collapsed chats section but marks them collapsed', () => {
    const rows = buildSidebarRows(
      [
        {
          workspace: workspace({ id: 'chat-w', kind: 'casual' }),
          threads: [thread({ id: 'chat-t', workspace_id: 'chat-w', title: 'Weekend plans' })],
        },
      ],
      emptyCollapsed,
      defaultCounts,
      null,
      'last_updated',
      true,
      true,
    )

    expect(rows).toEqual([
      {
        key: 'section:chats',
        type: 'section',
        title: 'Chats',
        isOpen: false,
      },
      expect.objectContaining({
        key: 'chat:chat-w:chat-t',
        type: 'thread',
        isCollapsed: true,
      }),
    ])
  })

  it('keeps the Chats section visible before the first casual chat exists', () => {
    const rows = buildSidebarRows(
      [
        {
          workspace: workspace({ id: 'project-w', kind: 'project', path: '/tmp/project' }),
          threads: [],
        },
      ],
      emptyCollapsed,
      defaultCounts,
      null,
      'last_updated',
      true,
    )

    expect(rows.map((row) => row.key)).toEqual([
      'section:projects',
      'workspace:project-w',
      'section:chats',
    ])
  })

  it('falls back to the full workspace path when no basename exists', () => {
    const rows = buildSidebarRows(
      [
        {
          workspace: workspace({ id: 'w1', path: '' }),
          threads: [],
        },
      ],
      emptyCollapsed,
      defaultCounts,
      null,
    )

    expect(rows[1]).toEqual({
      key: 'workspace:w1',
      type: 'workspace',
      workspaceId: 'w1',
      workspaceName: 'Workspace',
      isOpen: true,
      runningCount: 0,
      unreadCount: 0,
      unreadTone: 'info',
    })
  })

  it('rolls up running and unread threads onto the workspace row', () => {
    const rows = buildSidebarRows(
      [
        {
          workspace: workspace({ id: 'w1', path: '/tmp/project' }),
          threads: [
            thread({ id: 't1', workspace_id: 'w1', status: 'running' }),
            thread({
              id: 't2',
              workspace_id: 'w1',
              attention: {
                level: 'none',
                badge_label: null,
                unread: true,
                pending_approval_count: 0,
                pending_question_count: 0,
                last_agent_activity_seq: 0,
                last_read_seq: 0,
              },
            }),
            thread({ id: 't3', workspace_id: 'w1' }),
          ],
        },
      ],
      new Set(['w1']),
      defaultCounts,
      null,
    )

    expect(rows[1]).toMatchObject({
      type: 'workspace',
      runningCount: 1,
      unreadCount: 1,
      unreadTone: 'info',
    })
  })

  it('keeps thread rows for a collapsed workspace but marks them collapsed', () => {
    const collapsed = new Set(['w1'])
    const rows = buildSidebarRows(
      [
        {
          workspace: workspace({ id: 'w1', path: '/tmp/project' }),
          threads: [thread({ id: 't1', workspace_id: 'w1' })],
        },
      ],
      collapsed,
      defaultCounts,
      null,
    )

    // Rows stay in the data (same keys) so collapse can animate the cells
    // shut instead of unmounting them.
    expect(rows).toHaveLength(3)
    expect(rows[1]!.type).toBe('workspace')
    expect((rows[1] as any).isOpen).toBe(false)
    expect(rows[2]).toMatchObject({ key: 'thread:t1', type: 'thread', isCollapsed: true })
  })

  it('orders pinned threads with the same sort mode as project chats', () => {
    const rows = buildSidebarRows(
      [
        {
          workspace: workspace({ id: 'w1', path: '/tmp/project' }),
          threads: [
            thread({
              id: 'pinned-z',
              workspace_id: 'w1',
              title: 'Zebra',
              is_pinned: true,
              is_pinned_in_project: false,
              updated_at: '2026-03-16T12:00:00Z',
            }),
            thread({ id: 'regular', workspace_id: 'w1', title: 'Regular' }),
          ],
        },
        {
          workspace: workspace({ id: 'w2', path: '/tmp/other' }),
          threads: [
            thread({
              id: 'pinned-a',
              workspace_id: 'w2',
              title: 'Alpha',
              is_pinned: true,
              is_pinned_in_project: false,
              updated_at: '2026-03-16T11:00:00Z',
            }),
          ],
        },
      ],
      emptyCollapsed,
      defaultCounts,
      null,
      'alphabetical',
    )

    expect(
      rows.filter((row) => row.type === 'thread' && row.key.startsWith('pinned:')).map((row) => {
        return row.type === 'thread' ? row.thread.id : null
      }),
    ).toEqual(['pinned-a', 'pinned-z'])
  })

  it('places pinned threads above projects and removes them from project rows', () => {
    const rows = buildSidebarRows(
      [
        {
          workspace: workspace({ id: 'w1', path: '/tmp/project' }),
          threads: [
            thread({ id: 'pinned', workspace_id: 'w1', is_pinned: true }),
            thread({ id: 'regular', workspace_id: 'w1' }),
          ],
        },
      ],
      new Set(['w1']),
      defaultCounts,
      'pinned',
    )

    expect(rows.map((row) => row.key)).toEqual([
      'section:pinned',
      'pinned:w1:pinned',
      'section:projects',
      'workspace:w1',
      'thread:regular',
    ])
    expect(rows[1]).toMatchObject({ isCollapsed: false })
    expect(rows[4]).toMatchObject({ isCollapsed: true })
  })

  it('keeps pin-in-project chats at the top of their project', () => {
    const rows = buildSidebarRows(
      [
        {
          workspace: workspace({ id: 'w1', path: '/tmp/project' }),
          threads: [
            thread({
              id: 'regular',
              workspace_id: 'w1',
              title: 'Regular',
              updated_at: '2026-03-16T12:00:00Z',
            }),
            thread({
              id: 'project-pinned',
              workspace_id: 'w1',
              title: 'Pinned in project',
              is_pinned_in_project: true,
              updated_at: '2026-03-10T10:00:00Z',
            }),
          ],
        },
      ],
      emptyCollapsed,
      defaultCounts,
      null,
    )

    expect(rows.map((row) => row.key)).toEqual([
      'section:projects',
      'workspace:w1',
      'thread:project-pinned',
      'thread:regular',
    ])
  })

  it('limits visible threads and shows overflow row', () => {
    const threads = Array.from({ length: 8 }, (_, i) => thread({ id: `t${i}`, workspace_id: 'w1' }))
    const rows = buildSidebarRows(
      [{ workspace: workspace({ id: 'w1', path: '/tmp/p' }), threads }],
      emptyCollapsed,
      defaultCounts,
      null,
    )

    const threadRows = rows.filter((r) => r.type === 'thread')
    expect(threadRows).toHaveLength(VISIBLE_THREAD_LIMIT)

    const overflow = rows.find((r) => r.type === 'overflow')
    expect(overflow).toBeDefined()
    expect((overflow as any).hiddenCount).toBe(3)
    expect((overflow as any).isExpanded).toBe(false)
  })

  it('shows more threads incrementally when a larger count is requested', () => {
    const threads = Array.from({ length: 20 }, (_, i) =>
      thread({ id: `t${i}`, workspace_id: 'w1' }),
    )
    const counts = new Map([['w1', VISIBLE_THREAD_LIMIT + 10]])
    const rows = buildSidebarRows(
      [{ workspace: workspace({ id: 'w1', path: '/tmp/p' }), threads }],
      emptyCollapsed,
      counts,
      null,
    )

    const threadRows = rows.filter((r) => r.type === 'thread')
    expect(threadRows).toHaveLength(15)

    const overflow = rows.find((r) => r.type === 'overflow')
    expect((overflow as any).hiddenCount).toBe(5)
    expect((overflow as any).visibleCount).toBe(15)
    expect((overflow as any).isExpanded).toBe(false)
  })

  it('offers Show less once every thread is visible', () => {
    const threads = Array.from({ length: 8 }, (_, i) => thread({ id: `t${i}`, workspace_id: 'w1' }))
    const counts = new Map([['w1', 15]])
    const rows = buildSidebarRows(
      [{ workspace: workspace({ id: 'w1', path: '/tmp/p' }), threads }],
      emptyCollapsed,
      counts,
      null,
    )

    const threadRows = rows.filter((r) => r.type === 'thread')
    expect(threadRows).toHaveLength(8)

    const overflow = rows.find((r) => r.type === 'overflow')
    expect((overflow as any).hiddenCount).toBe(0)
    expect((overflow as any).isExpanded).toBe(true)
  })

  it('extends the visible range just enough to include a hidden selected thread', () => {
    const threads = Array.from({ length: 8 }, (_, i) => thread({ id: `t${i}`, workspace_id: 'w1' }))
    const rows = buildSidebarRows(
      [{ workspace: workspace({ id: 'w1', path: '/tmp/p' }), threads }],
      emptyCollapsed,
      defaultCounts,
      't6', // beyond the visible limit
    )

    const threadRows = rows.filter((r) => r.type === 'thread')
    expect(threadRows).toHaveLength(7) // t0..t6 shown so the selection stays visible

    const overflow = rows.find((r) => r.type === 'overflow')
    expect((overflow as any).hiddenCount).toBe(1)
  })
})

describe('sidebarRowsEqual', () => {
  const groups = [
    {
      workspace: workspace({ id: 'w1', path: '/tmp/project-one' }),
      threads: [
        thread({ id: 't1', workspace_id: 'w1' }),
        thread({ id: 't2', workspace_id: 'w1' }),
      ],
    },
  ]

  it('treats a rebuild for a plain selection change as equal', () => {
    const before = buildSidebarRows(groups, emptyCollapsed, defaultCounts, null)
    const after = buildSidebarRows(groups, emptyCollapsed, defaultCounts, 't1')
    expect(after).not.toBe(before)
    expect(sidebarRowsEqual(before, after)).toBe(true)
  })

  it('detects a selection that expands the visible window', () => {
    const manyThreads = [
      {
        workspace: workspace({ id: 'w1', path: '/tmp/project-one' }),
        threads: Array.from({ length: VISIBLE_THREAD_LIMIT + 2 }, (_, index) =>
          thread({
            id: `t${index}`,
            workspace_id: 'w1',
            updated_at: `2026-03-0${(index % 9) + 1}T10:00:00Z`,
          }),
        ),
      },
    ]
    const before = buildSidebarRows(manyThreads, emptyCollapsed, defaultCounts, null)
    const hidden = buildSidebarRows(manyThreads, emptyCollapsed, defaultCounts, null)
      .filter((row) => row.type === 'thread')
    const overflowed = manyThreads[0].threads.find(
      (candidate) => !hidden.some((row) => row.type === 'thread' && row.thread.id === candidate.id),
    )
    expect(overflowed).toBeDefined()
    const after = buildSidebarRows(manyThreads, emptyCollapsed, defaultCounts, overflowed!.id)
    expect(sidebarRowsEqual(before, after)).toBe(false)
  })

  it('detects content changes with identical keys', () => {
    const before = buildSidebarRows(groups, emptyCollapsed, defaultCounts, null)
    const renamed = [
      {
        workspace: groups[0].workspace,
        threads: [
          thread({ id: 't1', workspace_id: 'w1', title: 'Renamed' }),
          groups[0].threads[1],
        ],
      },
    ]
    const after = buildSidebarRows(renamed, emptyCollapsed, defaultCounts, null)
    expect(sidebarRowsEqual(before, after)).toBe(false)
  })

  it('tucks archived chats behind a disclosure under the project', () => {
    const rows = buildSidebarRows(
      [
        {
          workspace: workspace({ id: 'w1', path: '/tmp/project-one' }),
          threads: [thread({ id: 't1', workspace_id: 'w1' })],
          archivedThreads: [
            thread({
              id: 'old',
              workspace_id: 'w1',
              title: 'Old work',
              is_archived: true,
            }),
          ],
        },
      ],
      emptyCollapsed,
      defaultCounts,
      null,
    )

    expect(rows.map((row) => row.key)).toEqual([
      'section:projects',
      'workspace:w1',
      'thread:t1',
      'archived-toggle:w1',
      'archived:old',
    ])
    const toggle = rows.find((row) => row.type === 'archived-toggle')
    expect(toggle).toMatchObject({ count: 1, isOpen: false, isCollapsed: false })
    const archived = rows.find((row) => row.key === 'archived:old')
    expect(archived).toMatchObject({ type: 'thread', isCollapsed: true })
  })

  it('detects length changes', () => {
    const before = buildSidebarRows(groups, emptyCollapsed, defaultCounts, null)
    const after = buildSidebarRows(
      [{ workspace: groups[0].workspace, threads: groups[0].threads.slice(0, 1) }],
      emptyCollapsed,
      defaultCounts,
      null,
    )
    expect(sidebarRowsEqual(before, after)).toBe(false)
  })
})
