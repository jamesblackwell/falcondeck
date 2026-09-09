import { beforeEach, expect, it } from 'vitest'
import { expandSyncIndex, mergeSyncThreadPage } from '@falcondeck/client-core'
import { assistantMessage, snapshot, snapshotEvent, thread, threadDetail, workspace } from '@/test/factories'
import { useSessionStore } from './session-store'

beforeEach(() => useSessionStore.getState().reset())

function partialIndex(threads = [thread({ id: 'other' })]) {
  return expandSyncIndex({ token: 'fresh', snapshot: snapshot({ threads }),
    agent_catalogs: [], model_catalogs: [], workspace_agents: {}, workspace_models: {},
    counts: { 'workspace-1': { total: 3, running: 0, unread: 0, awaiting: 0 } } })
}

it('retains the open transcript and recent threads when a partial refresh omits them', () => {
  const store = useSessionStore.getState()
  store.applyDaemonEvent(snapshotEvent(snapshot({ threads: [thread(), thread({ id: 'recent' })] })))
  store.selectThread('workspace-1', 'thread-1')
  store.setThreadDetail(threadDetail({ items: [assistantMessage('reply', 'Visible reply')] }))
  store.applyDaemonEvent(snapshotEvent(partialIndex()))
  const state = useSessionStore.getState()
  expect(state.selectedThreadId).toBe('thread-1')
  expect(state.threadDetail?.items).toMatchObject([{ id: 'reply', text: 'Visible reply' }])
  expect(state.threadItems['thread-1']).toMatchObject([{ id: 'reply' }])
  expect(state.snapshot?.threads.map(row => row.id)).toEqual(['other', 'thread-1', 'recent'])
})

it('refreshes retained rows from pages and removes missing rows only after a complete traversal', () => {
  const store = useSessionStore.getState()
  store.applyDaemonEvent(snapshotEvent(snapshot({ threads: [thread(), thread({ id: 'deleted' })] })))
  store.applyDaemonEvent(snapshotEvent(partialIndex()))
  const first = mergeSyncThreadPage(useSessionStore.getState().snapshot!, {
    token: 'fresh', workspace_id: 'workspace-1', threads: [thread({ title: 'Renamed' })], next_cursor: 1,
  }, 'last_updated')
  expect(first.threads.find(row => row.id === 'thread-1')?.title).toBe('Renamed')
  expect(first.threads.some(row => row.id === 'deleted')).toBe(true)
  const last = mergeSyncThreadPage(first, {
    token: 'fresh', workspace_id: 'workspace-1', threads: [], next_cursor: null,
  }, 'last_updated')
  expect(last.threads.some(row => row.id === 'deleted')).toBe(false)
})

it('does not retain rows from removed or now-empty workspaces, or from a full snapshot', () => {
  const store = useSessionStore.getState()
  const original = snapshot({ workspaces: [workspace(), workspace({ id: 'removed' })],
    threads: [thread(), thread({ id: 'removed-thread', workspace_id: 'removed' })] })
  store.applyDaemonEvent(snapshotEvent(original))
  const empty = partialIndex([])
  empty.sync_index!.counts['workspace-1'].total = 0
  store.applyDaemonEvent(snapshotEvent(empty))
  expect(useSessionStore.getState().snapshot?.threads).toEqual([])
  store.applyDaemonEvent(snapshotEvent(original))
  store.applyDaemonEvent(snapshotEvent(snapshot({ threads: [] })))
  expect(useSessionStore.getState().snapshot?.threads).toEqual([])
})

it('keeps live updates newer than the frozen page for retained threads', () => {
  const store = useSessionStore.getState()
  store.applyDaemonEvent(snapshotEvent(snapshot()))
  store.applyDaemonEvent(snapshotEvent(partialIndex()))
  store.applyDaemonEvent({ seq: 10, emitted_at: '2026-09-09T12:00:00Z', workspace_id: 'workspace-1', thread_id: 'thread-1',
    event: { type: 'thread-updated', thread: thread({ title: 'Live update', updated_at: '2026-09-09T12:00:00Z' }) } })
  const merged = mergeSyncThreadPage(useSessionStore.getState().snapshot!, {
    token: 'fresh', workspace_id: 'workspace-1', threads: [thread()], next_cursor: null,
  }, 'last_updated')
  expect(merged.threads.find(row => row.id === 'thread-1')?.title).toBe('Live update')
})
