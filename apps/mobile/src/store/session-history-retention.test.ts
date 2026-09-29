import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { assistantMessage, snapshot, thread, threadDetail } from '@/test/factories'
import { useSessionStore } from './session-store'

beforeEach(() => { vi.useFakeTimers(); useSessionStore.getState().reset() })
afterEach(() => { useSessionStore.getState().reset(); vi.useRealTimers() })
function visit(id: string, text = 'small', count = 20) {
  const store = useSessionStore.getState()
  store.selectThread('workspace-1', id)
  store.setThreadDetail(threadDetail({ thread: thread({ id }),
    items: Array.from({ length: count }, (_, index) => assistantMessage(id + '-' + index, text)),
    has_older: true, is_partial: true }))
}

it('retains five recent windows instead of all thirty visited histories', () => {
  useSessionStore.setState({ snapshot: snapshot({ threads: Array.from({ length: 30 }, (_, index) => thread({ id: 't-' + index })) }) })
  for (let index = 0; index < 30; index++) visit('t-' + index, 'x'.repeat(8192))
  const state = useSessionStore.getState()
  expect(Object.keys(state.threadItems)).toHaveLength(5)
  expect(Object.values(state.threadItems).flat()).toHaveLength(100)
  expect(Object.keys(state.threadHistory).sort()).toEqual(Object.keys(state.threadItems).sort())
  expect(state.threadItems['t-29']).toHaveLength(20)
})

it('keeps a revisited history ahead of less recently used windows', () => {
  for (let index = 0; index < 5; index++) visit('t-' + index)
  useSessionStore.getState().selectThread('workspace-1', 't-0')
  visit('t-5')
  expect(useSessionStore.getState().threadItems['t-0']).toHaveLength(20)
  expect(useSessionStore.getState().threadItems['t-1']).toBeUndefined()
})

it('keeps selected older pages intact and evicts oversized inactive windows with cursors', () => {
  visit('large', 'x'.repeat(3 * 1024 * 1024), 1)
  const store = useSessionStore.getState()
  store.setThreadDetail(threadDetail({ thread: thread({ id: 'large' }),
    items: [assistantMessage('older', 'older')], has_older: true, is_partial: true }), { mergeMode: 'prepend' })
  expect(useSessionStore.getState().threadItems.large).toHaveLength(2)
  expect(useSessionStore.getState().threadDetail?.items).toHaveLength(2)
  visit('small')
  expect(useSessionStore.getState().threadItems.large).toBeUndefined()
  expect(useSessionStore.getState().threadHistory.large).toBeUndefined()
  useSessionStore.getState().selectThread('workspace-1', 'large')
  useSessionStore.getState().setThreadDetail(threadDetail({ thread: thread({ id: 'large' }),
    items: [assistantMessage('fresh-tail', 'fresh')], has_older: true, is_partial: true }))
  expect(useSessionStore.getState().threadItems.large.map(item => item.id)).toEqual(['fresh-tail'])
  expect(useSessionStore.getState().threadHistory.large.oldestItemId).toBe('fresh-tail')
})

it('bounds bytes across inactive windows even below the thread count limit', () => {
  for (let index = 0; index < 4; index++) visit('large-' + index, 'x'.repeat(1024 * 1024), 1)
  const state = useSessionStore.getState()
  expect(Object.keys(state.threadItems)).toHaveLength(2)
  expect(state.threadItems['large-3']).toBeDefined()
  expect(state.threadItems['large-2']).toBeDefined()
})

it('also budgets background detail responses and leaving for a new conversation', () => {
  visit('selected')
  const store = useSessionStore.getState()
  for (let index = 0; index < 10; index++) store.setThreadDetail(
    threadDetail({ thread: thread({ id: 'background-' + index }), items: [assistantMessage('item', 'tail')] }))
  expect(Object.keys(useSessionStore.getState().threadItems)).toHaveLength(5)
  expect(useSessionStore.getState().threadItems.selected).toHaveLength(20)
  visit('oversized', 'x'.repeat(3 * 1024 * 1024), 1)
  useSessionStore.getState().selectNewThread('workspace-1')
  expect(useSessionStore.getState().threadItems.oversized).toBeUndefined()
})
