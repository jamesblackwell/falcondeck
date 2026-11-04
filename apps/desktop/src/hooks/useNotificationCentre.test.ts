import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  MarkNotificationsReadRequest,
  NotificationCounts,
  NotificationListQuery,
  NotificationListResponse,
  NotificationRecord,
} from '@falcondeck/client-core'

import { useNotificationCentre, type NotificationCentreApi } from './useNotificationCentre'

const control = vi.hoisted(() => ({ fire: (() => {}) as (domains: string[]) => void }))
vi.mock('./useControlStateEvents', () => ({
  useControlStateEvents: (_url: string | null, onChange: (revision: number, domains: string[]) => void) => {
    control.fire = (domains) => onChange(1, domains)
  },
}))

function row(seq: number, overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: `N-${seq}`,
    seq,
    kind: 'turn_complete',
    title: `Task ${seq}`,
    preview: 'Done.',
    created_at: '2026-11-04T10:00:00Z',
    importance: 'normal',
    has_body: false,
    repeat_count: 0,
    ...overrides,
  }
}

/** A daemon with real paging and counts, snapshotting on arrival as the real one does. */
class FakeDaemon implements NotificationCentreApi {
  rows: NotificationRecord[]
  lists: NotificationListQuery[] = []
  reads: MarkNotificationsReadRequest[] = []
  failure: unknown = null
  failReads: unknown = null
  holdReads = false
  holdOlder = false
  private held: (() => void)[] = []
  constructor(rows: NotificationRecord[] = []) {
    this.rows = rows
  }
  get heldCount() {
    return this.held.length
  }
  release() {
    const waiting = this.held
    this.held = []
    waiting.forEach((resume) => resume())
  }
  private counts(): NotificationCounts {
    return {
      unread_count: this.rows.filter((item) => !item.read_at).length,
      needs_you_count: this.rows.filter((item) => item.kind === 'review' && !item.resolved_at).length,
      latest_seq: Math.max(0, ...this.rows.map((item) => item.seq)),
    }
  }
  async listNotifications(query: NotificationListQuery = {}): Promise<NotificationListResponse> {
    this.lists.push(query)
    if (this.failure) throw this.failure
    const matching = [...this.rows]
      .sort((a, b) => b.seq - a.seq)
      .filter((item) => query.before_seq === undefined || item.seq < query.before_seq)
      .filter((item) => {
        if (query.filter === 'needs_you') return item.kind === 'review' && !item.resolved_at
        if (query.filter === 'bots') return item.kind === 'agent_notice' || Boolean(item.bot)
        return true
      })
    const limit = query.limit ?? 50
    const items = matching.slice(0, limit)
    const response: NotificationListResponse = { ...this.counts(), items }
    if (matching.length > limit) response.next_before_seq = items[items.length - 1].seq
    if (this.holdOlder && query.before_seq !== undefined) {
      await new Promise<void>((resume) => this.held.push(resume))
    }
    return response
  }
  async getNotification(id: string): Promise<NotificationRecord> {
    return this.rows.find((item) => item.id === id)!
  }
  async markNotificationsRead(request: MarkNotificationsReadRequest): Promise<NotificationCounts> {
    this.reads.push(request)
    if (this.holdReads) await new Promise<void>((resume) => this.held.push(resume))
    if (this.failReads) throw this.failReads
    const ids = new Set(request.ids ?? [])
    const shown = (item: NotificationRecord) => request.filter !== 'bots' || item.kind === 'agent_notice' || Boolean(item.bot)
    this.rows = this.rows.map((item) =>
      ids.has(item.id) || (item.seq <= (request.up_to_seq ?? -1) && shown(item))
        ? { ...item, read_at: '2026-11-04T11:00:00Z' }
        : item,
    )
    return this.counts()
  }
}

function mount(api: FakeDaemon, onNewNotices?: (notices: NotificationRecord[]) => void) {
  return renderHook(() => useNotificationCentre({ api, baseUrl: 'http://daemon', enabled: true, onNewNotices }))
}

async function loaded(api: FakeDaemon, onNewNotices?: (notices: NotificationRecord[]) => void) {
  const view = mount(api, onNewNotices)
  await waitFor(() => expect(view.result.current.loading).toBe(false))
  return view
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => row(from + index))

afterEach(cleanup)

describe('useNotificationCentre', () => {
  it('loads a page newest first with the counts for the whole store', async () => {
    const { result } = await loaded(new FakeDaemon(range(1, 60)))
    expect(result.current.records).toHaveLength(50)
    expect(result.current.records[0].id).toBe('N-60')
    expect(result.current.counts).toMatchObject({ unread_count: 60, latest_seq: 60 })
    expect(result.current.hasMore).toBe(true)
    await act(() => result.current.loadMore())
    expect(result.current.records).toHaveLength(60)
    expect(result.current.hasMore).toBe(false)
  })

  it('leaves no gap below a backlog', async () => {
    const api = new FakeDaemon(range(1, 100))
    const { result } = await loaded(api)
    api.rows = range(1, 200)
    await act(() => result.current.refresh())
    expect(result.current.records[0].seq).toBe(200)
    await act(() => result.current.loadMore())
    expect(result.current.records.map((item) => item.seq)).toEqual(range(101, 200).map((item) => item.seq).reverse().slice(0, 100))
  })

  it('carries a change from another device through every loaded row', async () => {
    const api = new FakeDaemon(range(1, 300))
    const { result } = await loaded(api)
    for (let page = 0; page < 5; page++) await act(() => result.current.loadMore())
    expect(result.current.records).toHaveLength(300)
    api.rows = api.rows.map((item) => ({ ...item, read_at: '2026-11-04T11:00:00Z' }))
    await act(() => result.current.refresh())
    expect(result.current.records.filter((item) => !item.read_at)).toEqual([])
    expect(api.lists.slice(-2).map((query) => query.limit)).toEqual([200, 100])
  })

  it('keeps the old list when a later page of a walk fails', async () => {
    const api = new FakeDaemon(range(1, 300))
    const { result } = await loaded(api)
    for (let page = 0; page < 5; page++) await act(() => result.current.loadMore())
    const list = api.listNotifications.bind(api)
    api.listNotifications = async (query) => {
      if (query?.before_seq !== undefined) throw new Error('relay down')
      return list(query)
    }
    await act(() => result.current.refresh())
    expect(result.current.records).toHaveLength(300)
    expect(result.current.error).toBe('relay down')
  })

  it('marks read at once and takes the daemon counts', async () => {
    const api = new FakeDaemon(range(1, 3))
    const { result } = await loaded(api)
    await act(() => result.current.markRead('N-3'))
    expect(api.reads).toEqual([{ ids: ['N-3'] }])
    expect(result.current.records[0].read_at).toBeDefined()
    expect(result.current.counts.unread_count).toBe(2)
  })

  it('sends a read for a record outside the list on screen', async () => {
    const api = new FakeDaemon([row(1), row(2, { kind: 'agent_notice' })])
    const { result } = await loaded(api)
    act(() => result.current.setFilter('needs_you'))
    await waitFor(() => expect(result.current.records).toEqual([]))
    await act(() => result.current.markRead('N-2'))
    expect(api.reads).toEqual([{ ids: ['N-2'] }])
    expect(result.current.counts.unread_count).toBe(1)
  })

  it('keeps paging after the daemon changes during a page', async () => {
    const first = new FakeDaemon(range(1, 60))
    const second = new FakeDaemon(range(1, 60))
    const { result, rerender } = renderHook(
      ({ api }) => useNotificationCentre({ api, baseUrl: 'http://daemon', enabled: true }),
      { initialProps: { api: first } },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    first.holdOlder = true
    let older!: Promise<void>
    act(() => {
      older = result.current.loadMore()
    })
    await waitFor(() => expect(first.heldCount).toBe(1))
    rerender({ api: second })
    await waitFor(() => expect(result.current.records).toHaveLength(50))
    expect(result.current.loadingMore).toBe(false)
    await act(async () => {
      first.release()
      await older
    })
    await act(() => result.current.loadMore())
    expect(result.current.records).toHaveLength(60)
  })

  it('does not send a read for a row already read', async () => {
    const api = new FakeDaemon([row(1, { read_at: '2026-11-04T11:00:00Z' })])
    const { result } = await loaded(api)
    await act(() => result.current.markRead('N-1'))
    expect(api.reads).toEqual([])
  })

  it('puts a refused read back and says so', async () => {
    const api = new FakeDaemon(range(1, 2))
    const { result } = await loaded(api)
    api.failReads = new Error('disk full')
    await act(() => result.current.markRead('N-2'))
    expect(result.current.records[0].read_at).toBeUndefined()
    expect(result.current.counts.unread_count).toBe(2)
    expect(result.current.error).toBe('disk full')
  })

  it('mark all covers what was shown, so a newer record stays unread', async () => {
    const api = new FakeDaemon(range(1, 3))
    const { result } = await loaded(api)
    api.rows.push(row(4))
    await act(() => result.current.markAllRead())
    expect(api.reads).toEqual([{ up_to_seq: 3 }])
    expect(api.rows.find((item) => item.id === 'N-4')?.read_at).toBeUndefined()
  })

  it('mark all keeps to the filter on screen', async () => {
    const api = new FakeDaemon([row(1), row(2, { kind: 'agent_notice' })])
    const { result } = await loaded(api)
    act(() => result.current.setFilter('bots'))
    await waitFor(() => expect(result.current.records.map((item) => item.id)).toEqual(['N-2']))
    await act(() => result.current.markAllRead())
    expect(api.reads).toEqual([{ up_to_seq: 2, filter: 'bots' }])
    expect(api.rows.find((item) => item.id === 'N-1')?.read_at).toBeUndefined()
    expect(result.current.counts.unread_count).toBe(1)
  })

  it('only a head read moves the mark-all boundary', async () => {
    const api = new FakeDaemon(range(1, 60))
    const { result } = await loaded(api)
    api.rows.push(row(61))
    await act(() => result.current.loadMore())
    expect(result.current.counts.latest_seq).toBe(60)
    await act(() => result.current.markRead('N-60'))
    expect(result.current.counts.latest_seq).toBe(60)
  })

  it('settles overlapping reads with a refresh', async () => {
    const api = new FakeDaemon(range(1, 2))
    const { result } = await loaded(api)
    const listed = api.lists.length
    api.holdReads = true
    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.markRead('N-2')
      second = result.current.markRead('N-1')
    })
    await waitFor(() => expect(api.heldCount).toBe(2))
    api.holdReads = false
    await act(async () => {
      api.release()
      await Promise.all([first, second])
    })
    await waitFor(() => expect(api.lists.length).toBeGreaterThan(listed))
    await waitFor(() => expect(result.current.counts.unread_count).toBe(0))
  })

  it('drops an older page that crossed a read', async () => {
    const api = new FakeDaemon(range(1, 60))
    const { result } = await loaded(api)
    api.holdOlder = true
    let older!: Promise<void>
    act(() => {
      older = result.current.loadMore()
    })
    await waitFor(() => expect(api.heldCount).toBe(1))
    await act(() => result.current.markRead('N-60'))
    await act(async () => {
      api.release()
      await older
    })
    expect(result.current.records).toHaveLength(50)
    expect(result.current.hasMore).toBe(true)
  })

  it('asks the daemon for each filter', async () => {
    const api = new FakeDaemon([row(1), row(2, { kind: 'review' }), row(3, { kind: 'agent_notice' })])
    const { result } = await loaded(api)
    act(() => result.current.setFilter('needs_you'))
    await waitFor(() => expect(result.current.records.map((item) => item.id)).toEqual(['N-2']))
    act(() => result.current.setFilter('bots'))
    await waitFor(() => expect(result.current.records.map((item) => item.id)).toEqual(['N-3']))
    expect(result.current.counts.unread_count).toBe(3)
  })

  it('refreshes on the notifications control event only', async () => {
    const api = new FakeDaemon(range(1, 2))
    await loaded(api)
    const listed = api.lists.length
    act(() => control.fire(['reviews']))
    expect(api.lists).toHaveLength(listed)
    await act(async () => control.fire(['notifications']))
    await waitFor(() => expect(api.lists.length).toBeGreaterThan(listed))
  })

  it('hides itself on a daemon without the centre', async () => {
    const api = new FakeDaemon()
    api.failure = Object.assign(new Error('Not found'), { status: 404 })
    const { result } = await loaded(api)
    expect(result.current.unsupported).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('reveals new notices, never the history at launch', async () => {
    const onNew = vi.fn()
    const api = new FakeDaemon([row(1, { kind: 'agent_notice' })])
    const { result } = await loaded(api, onNew)
    expect(onNew).not.toHaveBeenCalled()
    api.rows.push(row(2), row(3, { kind: 'agent_notice' }))
    await act(() => result.current.refresh())
    expect(onNew).toHaveBeenCalledTimes(1)
    expect(onNew.mock.calls[0][0].map((item: NotificationRecord) => item.id)).toEqual(['N-3'])
    await act(() => result.current.refresh())
    expect(onNew).toHaveBeenCalledTimes(1)
  })

  it('reveals a notice while the list shows only what needs you', async () => {
    const onNew = vi.fn()
    const api = new FakeDaemon([row(1, { kind: 'review' })])
    const { result } = await loaded(api, onNew)
    act(() => result.current.setFilter('needs_you'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    api.rows.push(row(2, { kind: 'agent_notice' }))
    await act(() => result.current.refresh())
    expect(onNew).toHaveBeenCalledTimes(1)
  })
})
