import { describe, expect, it } from 'vitest'

import { workspace, thread } from '@/test/factories'

import { buildSidebarRows, VISIBLE_THREAD_LIMIT } from './sidebarRows'

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
        threadCount: 2,
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
      threadCount: 0,
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
