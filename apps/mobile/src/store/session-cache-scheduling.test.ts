import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MobileSessionCache } from '@falcondeck/client-core'

const { persistCache } = vi.hoisted(() => ({ persistCache: vi.fn() }))
vi.mock('@/storage/mobile-session-cache', () => ({
  clearMobileSessionCache: vi.fn(),
  persistMobileSessionCache: persistCache,
}))

import { assistantMessage, snapshot, thread, userMessage, workspace } from '@/test/factories'

import {
  __resetSessionCachePersistThrottleForTests,
  persistSessionCacheNow,
  useSessionStore,
} from './session-store'

beforeEach(() => {
  vi.useFakeTimers()
  useSessionStore.getState().reset()
  __resetSessionCachePersistThrottleForTests()
  persistCache.mockClear()
  useSessionStore.setState({
    snapshot: snapshot(),
    selectedWorkspaceId: 'workspace-1',
    selectedThreadId: 'thread-1',
  })
})

afterEach(() => {
  useSessionStore.getState().reset()
  vi.useRealTimers()
})

describe('send and new-thread cache scheduling', () => {
  it('defers RPC summary results while navigation is pending and writes the latest summary', () => {
    const store = useSessionStore.getState()
    store.selectThread('workspace-1', 'thread-1')
    const markedRead = thread({ attention: { ...thread().attention, last_read_seq: 7 } })
    store.applyThreadSummary(markedRead)
    expect(useSessionStore.getState().snapshot?.threads[0]).toBe(markedRead)
    expect(persistCache.mock.calls.length).toBe(0)

    const pinnedAndRenamed = { ...markedRead, is_pinned: true, title: 'Renamed task' }
    store.applyThreadSummary(pinnedAndRenamed)
    expect(persistCache.mock.calls.length).toBe(0)
    vi.advanceTimersByTime(1_000)
    expect(persistCache).toHaveBeenCalledTimes(1)
    const cached = persistCache.mock.calls[0][0] as MobileSessionCache
    expect(cached.snapshot.threads[0]).toMatchObject({
      title: 'Renamed task',
      is_pinned: true,
      attention: { last_read_seq: 7 },
    })
  })

  it('keeps full cache persistence out of the optimistic message insertion frame', () => {
    const pending = { ...userMessage('optimistic', 'Hello'), pending: true }
    useSessionStore.getState().upsertLocalThreadItem('thread-1', pending)
    expect(useSessionStore.getState().threadItems['thread-1']).toEqual([pending])
    expect(persistCache).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1_000)
    expect(persistCache).toHaveBeenCalledTimes(1)
    const cached = persistCache.mock.calls[0][0] as MobileSessionCache
    expect(cached.threadHistories['thread-1']).toBeUndefined()
  })

  it('coalesces a new-thread handle and messages into one current-state write', () => {
    const handle = {
      workspace: workspace({ current_thread_id: 'new-thread' }),
      thread: thread({ id: 'new-thread' }),
    }
    useSessionStore.getState().applyThreadHandle(handle)
    expect(useSessionStore.getState().snapshot?.threads[0]).toBe(handle.thread)
    expect(persistCache).not.toHaveBeenCalled()

    useSessionStore.getState().selectThread('workspace-1', 'new-thread')
    useSessionStore.getState().upsertLocalThreadItem('new-thread', userMessage('first', 'One'))
    useSessionStore.getState().upsertLocalThreadItem('new-thread', assistantMessage('second', 'Two'))
    expect(persistCache).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1_000)
    expect(persistCache).toHaveBeenCalledTimes(1)
    const cached = persistCache.mock.calls[0][0] as MobileSessionCache
    expect(cached.selectedThreadId).toBe('new-thread')
    expect(cached.threadHistories['new-thread'].items.map(item => item.id)).toEqual(['first', 'second'])
  })

  it('flushes deferred work before the relay checkpoint and cancels the pending write', () => {
    useSessionStore.getState().upsertLocalThreadItem('thread-1', userMessage('confirmed', 'Hello'))
    expect(persistCache).not.toHaveBeenCalled()

    persistSessionCacheNow()
    expect(persistCache).toHaveBeenCalledTimes(1)
    const cached = persistCache.mock.calls[0][0] as MobileSessionCache
    expect(cached.threadHistories['thread-1'].items.map(item => item.id)).toEqual(['confirmed'])
    vi.advanceTimersByTime(2_000)
    expect(persistCache).toHaveBeenCalledTimes(1)
  })

  it('defers queued or failed optimistic-send cleanup after the throttle window elapsed', () => {
    const store = useSessionStore.getState()
    store.upsertLocalThreadItem('thread-1', userMessage('confirmed', 'Earlier message'))
    const pending = { ...userMessage('optimistic', 'New message'), pending: true }
    store.upsertLocalThreadItem('thread-1', pending)
    vi.advanceTimersByTime(1_000)
    persistCache.mockClear()
    vi.advanceTimersByTime(1_000)

    store.removeLocalThreadItem('thread-1', 'optimistic')
    expect(useSessionStore.getState().threadItems['thread-1'].map(item => item.id)).toEqual(['confirmed'])
    expect(persistCache.mock.calls.length).toBe(0)
    vi.advanceTimersByTime(1_000)
    expect(persistCache).toHaveBeenCalledTimes(1)
    const cached = persistCache.mock.calls[0][0] as MobileSessionCache
    expect(cached.threadHistories['thread-1'].items.map(item => item.id)).toEqual(['confirmed'])
  })

  it('cancels deferred writes when the session is reset', () => {
    useSessionStore.getState().upsertLocalThreadItem('thread-1', userMessage('confirmed', 'Hello'))
    useSessionStore.getState().reset()
    vi.advanceTimersByTime(2_000)
    expect(persistCache).not.toHaveBeenCalled()
  })
})
