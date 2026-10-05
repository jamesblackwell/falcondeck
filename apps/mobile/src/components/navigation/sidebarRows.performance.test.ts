import { describe, expect, it } from 'vitest'

import { thread, workspace } from '@/test/factories'

import { buildSidebarRows, SHOW_MORE_STEP, VISIBLE_THREAD_LIMIT } from './sidebarRows'

describe('sidebar rows for large projects', () => {
  const threads = Array.from({ length: 10_000 }, (_, index) =>
    thread({ id: `t${index}`, workspace_id: 'w1' }),
  )
  const groups = [{ workspace: workspace({ id: 'w1' }), threads }]

  it.each([false, true])('keeps an old selected task visible with bounded rows (collapsed: %s)', collapsed => {
    const rows = buildSidebarRows(
      groups,
      new Set(collapsed ? ['w1'] : []),
      new Map(),
      't9999',
    )
    const taskRows = rows.filter(row => row.type === 'thread')

    expect(taskRows).toHaveLength(VISIBLE_THREAD_LIMIT + 1)
    expect(taskRows.map(row => row.thread.id)).toEqual(['t0', 't1', 't2', 't3', 't4', 't9999'])
    expect(taskRows.every(row => row.isCollapsed === collapsed)).toBe(true)
    expect(rows.find(row => row.type === 'overflow')).toMatchObject({
      visibleCount: VISIBLE_THREAD_LIMIT,
      hiddenCount: threads.length - VISIBLE_THREAD_LIMIT,
      isExpanded: false,
    })
  })

  it('advances Show more from the requested window instead of the selected task rank', () => {
    const counts = new Map([['w1', VISIBLE_THREAD_LIMIT + SHOW_MORE_STEP]])
    const rows = buildSidebarRows(groups, new Set(), counts, 't9999')
    const taskRows = rows.filter(row => row.type === 'thread')

    expect(taskRows).toHaveLength(VISIBLE_THREAD_LIMIT + SHOW_MORE_STEP + 1)
    expect(taskRows.slice(0, -1).map(row => row.thread.id)).toEqual(
      threads.slice(0, VISIBLE_THREAD_LIMIT + SHOW_MORE_STEP).map(task => task.id),
    )
    expect(taskRows.at(-1)?.thread.id).toBe('t9999')
    expect(rows.find(row => row.type === 'overflow')).toMatchObject({
      visibleCount: VISIBLE_THREAD_LIMIT + SHOW_MORE_STEP,
      isExpanded: false,
    })
  })

  it('does not duplicate a selected task inside the requested window', () => {
    const rows = buildSidebarRows(groups, new Set(), new Map(), 't3')
    const taskRows = rows.filter(row => row.type === 'thread')

    expect(taskRows).toHaveLength(VISIBLE_THREAD_LIMIT)
    expect(taskRows.filter(row => row.thread.id === 't3')).toHaveLength(1)
  })
})
