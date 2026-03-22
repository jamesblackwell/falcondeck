import { describe, expect, it } from 'vitest'

import { workspace, thread } from '@/test/factories'

import { buildSidebarRows, VISIBLE_THREAD_LIMIT } from './sidebarRows'

const emptyCollapsed = new Set<string>()
const emptyExpanded = new Set<string>()

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
      emptyExpanded,
      null,
    )

    expect(rows).toEqual([
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
      emptyExpanded,
      null,
    )

    expect(rows[0]).toEqual({
      key: 'workspace:w1',
      type: 'workspace',
      workspaceId: 'w1',
      workspaceName: 'Workspace',
      isOpen: true,
      threadCount: 0,
    })
  })

  it('collapses workspace and hides threads', () => {
    const collapsed = new Set(['w1'])
    const rows = buildSidebarRows(
      [
        {
          workspace: workspace({ id: 'w1', path: '/tmp/project' }),
          threads: [thread({ id: 't1', workspace_id: 'w1' })],
        },
      ],
      collapsed,
      emptyExpanded,
      null,
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]!.type).toBe('workspace')
    expect((rows[0] as any).isOpen).toBe(false)
  })

  it('limits visible threads and shows overflow row', () => {
    const threads = Array.from({ length: 8 }, (_, i) =>
      thread({ id: `t${i}`, workspace_id: 'w1' }),
    )
    const rows = buildSidebarRows(
      [{ workspace: workspace({ id: 'w1', path: '/tmp/p' }), threads }],
      emptyCollapsed,
      emptyExpanded,
      null,
    )

    const threadRows = rows.filter((r) => r.type === 'thread')
    expect(threadRows).toHaveLength(VISIBLE_THREAD_LIMIT)

    const overflow = rows.find((r) => r.type === 'overflow')
    expect(overflow).toBeDefined()
    expect((overflow as any).hiddenCount).toBe(3)
    expect((overflow as any).isExpanded).toBe(false)
  })

  it('expands thread list when requested', () => {
    const threads = Array.from({ length: 8 }, (_, i) =>
      thread({ id: `t${i}`, workspace_id: 'w1' }),
    )
    const expanded = new Set(['w1'])
    const rows = buildSidebarRows(
      [{ workspace: workspace({ id: 'w1', path: '/tmp/p' }), threads }],
      emptyCollapsed,
      expanded,
      null,
    )

    const threadRows = rows.filter((r) => r.type === 'thread')
    expect(threadRows).toHaveLength(8)

    const overflow = rows.find((r) => r.type === 'overflow')
    expect((overflow as any).isExpanded).toBe(true)
  })

  it('auto-expands when selected thread is hidden', () => {
    const threads = Array.from({ length: 8 }, (_, i) =>
      thread({ id: `t${i}`, workspace_id: 'w1' }),
    )
    const rows = buildSidebarRows(
      [{ workspace: workspace({ id: 'w1', path: '/tmp/p' }), threads }],
      emptyCollapsed,
      emptyExpanded,
      't6', // beyond the visible limit
    )

    const threadRows = rows.filter((r) => r.type === 'thread')
    expect(threadRows).toHaveLength(8) // all shown because selected is hidden
  })
})
