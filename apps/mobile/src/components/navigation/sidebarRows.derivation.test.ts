import { afterEach, describe, expect, it, vi } from 'vitest'
import { thread, workspace } from '@/test/factories'

const operations = vi.hoisted(() => ({
  partition: vi.fn(),
  attention: vi.fn(),
  compare: vi.fn(),
}))
vi.mock('@falcondeck/client-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@falcondeck/client-core')>()
  return {
    ...actual,
    partitionSidebarThreads: (...args: Parameters<typeof actual.partitionSidebarThreads>) => {
      operations.partition()
      return actual.partitionSidebarThreads(...args)
    },
    summarizeThreadAttention: (...args: Parameters<typeof actual.summarizeThreadAttention>) => {
      operations.attention()
      return actual.summarizeThreadAttention(...args)
    },
    compareThreads: (...args: Parameters<typeof actual.compareThreads>) => {
      const compare = actual.compareThreads(...args)
      return (...threads: Parameters<typeof compare>) => {
        operations.compare()
        return compare(...threads)
      }
    },
  }
})
import { buildSidebarRows, sidebarRowsEqual } from './sidebarRows'

const inventory = () => Array.from({ length: 72 }, (_, index) => ({
  workspace: workspace({ id: `w${index}`, path: `/tmp/project-${index}` }),
  threads: Array.from({ length: index < 46 ? 38 : 37 }, (_, threadIndex) => thread({
    id: `w${index}-t${threadIndex}`,
    workspace_id: `w${index}`,
    title: `Task ${threadIndex}`,
    updated_at: new Date(Date.UTC(2026, 9, 6, 0, 0, threadIndex)).toISOString(),
  })),
}))

afterEach(() => vi.clearAllMocks())

describe('immutable sidebar thread derivations', () => {
  it('does not partition, roll up or sort unchanged projects when selecting or collapsing', () => {
    const groups = inventory()
    expect(groups.reduce((count, group) => count + group.threads.length, 0)).toBe(2710)
    const rows = buildSidebarRows(groups, new Set(), new Map(), null)
    vi.clearAllMocks()

    const selected = buildSidebarRows(groups, new Set(), new Map(), 'w0-t37')
    expect(sidebarRowsEqual(rows, selected)).toBe(true)
    const collapsed = buildSidebarRows(groups, new Set(['w0']), new Map(), 'w0-t0')
    expect(collapsed.find(row => row.key === 'thread:w0-t0')).toMatchObject({ isCollapsed: true })
    expect(operations.partition).not.toHaveBeenCalled()
    expect(operations.attention).not.toHaveBeenCalled()
    expect(operations.compare).not.toHaveBeenCalled()
  })

  it('invalidates only the changed project and preserves attention, pinning and ordering', () => {
    const groups = inventory()
    buildSidebarRows(groups, new Set(), new Map(), null)
    const changed = thread({
      ...groups[0].threads[0], title: 'Updated task', status: 'running',
      is_pinned_in_project: true,
    })
    const unread = thread({
      ...groups[0].threads[1],
      attention: { ...groups[0].threads[1].attention, unread: true, level: 'unread' },
    })
    const next = [{ ...groups[0], threads: [changed, unread, ...groups[0].threads.slice(2)] }, ...groups.slice(1)]
    vi.clearAllMocks()
    const rows = buildSidebarRows(next, new Set(), new Map(), null)

    expect(operations.partition).toHaveBeenCalledTimes(1)
    expect(operations.attention).toHaveBeenCalledTimes(1)
    expect(rows[1]).toMatchObject({ workspaceId: 'w0', runningCount: 1, unreadCount: 1 })
    expect(rows[2]).toMatchObject({ type: 'thread', thread: changed })
    expect(operations.compare.mock.calls.length).toBeLessThan(100)
  })

  it('keeps sort caches independent and reuses them when switching back', () => {
    const groups = [{
      workspace: workspace(),
      threads: [
        thread({ id: 'a', title: 'Zulu', updated_at: '2026-10-06T11:00:00Z' }),
        thread({ id: 'b', title: 'Alpha', updated_at: '2026-10-06T10:00:00Z' }),
      ],
    }]
    const ids = (mode: 'last_updated' | 'alphabetical') =>
      buildSidebarRows(groups, new Set(), new Map(), null, mode)
        .filter(row => row.type === 'thread').map(row => row.thread.id)

    expect(ids('last_updated')).toEqual(['a', 'b'])
    expect(ids('alphabetical')).toEqual(['b', 'a'])
    vi.clearAllMocks()
    expect(ids('last_updated')).toEqual(['a', 'b'])
    expect(operations.partition).not.toHaveBeenCalled()
    expect(operations.attention).not.toHaveBeenCalled()
    expect(operations.compare).not.toHaveBeenCalled()
  })

  it('updates workspace metadata and remote counts without rescanning unchanged task arrays', () => {
    const groups = inventory()
    buildSidebarRows(groups, new Set(), new Map(), null)
    vi.clearAllMocks()
    const next = [{ ...groups[0], workspace: { ...groups[0].workspace, path: '/tmp/renamed' } }, ...groups.slice(1)]
    const rows = buildSidebarRows(next, new Set(), new Map(), null, 'last_updated', false, false, {
      w0: { total: 100, running: 3, unread: 2, awaiting: 0 },
    }, { 'w0:last_updated': 5 })
    expect(rows[1]).toMatchObject({ workspaceName: 'renamed', runningCount: 3, unreadCount: 2 })
    expect(rows.find(row => row.key === 'overflow:w0')).toMatchObject({ hiddenCount: 95 })
    expect(operations.partition).not.toHaveBeenCalled()
    expect(operations.attention).not.toHaveBeenCalled()
    expect(operations.compare).not.toHaveBeenCalled()
  })

  it('invalidates a previously cached priority sort after attention or pin placement changes', () => {
    const regular = thread({ id: 'regular', updated_at: '2026-10-06T10:00:00Z' })
    const recent = thread({ id: 'recent', updated_at: '2026-10-06T11:00:00Z' })
    const groups = [{ workspace: workspace(), threads: [recent, regular] }]
    const build = (input: typeof groups) => buildSidebarRows(input, new Set(), new Map(), null, 'priority')
    expect(build(groups).filter(row => row.type === 'thread').map(row => row.thread.id)).toEqual(['recent', 'regular'])

    const waiting = thread({
      ...regular,
      status: 'waiting_for_input',
      attention: { ...regular.attention, level: 'awaiting_response', pending_question_count: 1 },
    })
    const updated = [{ ...groups[0], threads: [recent, waiting] }]
    expect(build(updated).filter(row => row.type === 'thread').map(row => row.thread.id)).toEqual(['regular', 'recent'])
    const pinned = [{ ...groups[0], threads: [recent, thread({ ...waiting, is_pinned: true })] }]
    expect(build(pinned).find(row => row.key === 'pinned:workspace-1:regular')).toBeDefined()
    expect(build(pinned).some(row => row.key === 'thread:regular')).toBe(false)
    expect(build(groups).filter(row => row.type === 'thread').map(row => row.thread.id)).toEqual(['recent', 'regular'])
  })
})
