import { describe, it, expect, beforeEach } from 'vitest'

import { MOBILE_SESSION_CACHE_VERSION, buildProjectGroups } from '@falcondeck/client-core'
import { useSessionStore } from './session-store'
import {
  workspace,
  thread,
  snapshot,
  assistantMessage,
  userMessage,
  toolCall,
  serviceMessage,
  approval,
  threadDetail,
  snapshotEvent,
  conversationItemAddedEvent,
  threadUpdatedEvent,
} from '../test/factories'

function resetStore() {
  useSessionStore.getState().reset()
}

describe('session-store', () => {
  beforeEach(resetStore)

  describe('applyDaemonEvent — snapshot', () => {
    it('hydrates workspaces and threads from a snapshot event', () => {
      const snap = snapshot({
        workspaces: [workspace({ id: 'w1' }), workspace({ id: 'w2', path: '/tmp/other' })],
        threads: [thread({ id: 't1', workspace_id: 'w1' }), thread({ id: 't2', workspace_id: 'w2' })],
      })

      useSessionStore.getState().applyDaemonEvent(snapshotEvent(snap))

      const state = useSessionStore.getState()
      expect(state.snapshot).toBeTruthy()
      expect(state.snapshot!.workspaces).toHaveLength(2)
      expect(state.snapshot!.threads).toHaveLength(2)
    })

    it('replaces a previous snapshot entirely', () => {
      const first = snapshot({ threads: [thread({ id: 't1' })] })
      const second = snapshot({ threads: [thread({ id: 't2' }), thread({ id: 't3' })] })

      const { applyDaemonEvent } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(first))
      expect(useSessionStore.getState().snapshot!.threads).toHaveLength(1)

      applyDaemonEvent(snapshotEvent(second))
      expect(useSessionStore.getState().snapshot!.threads).toHaveLength(2)
    })
  })

  describe('applyDaemonEvent — conversation items', () => {
    it('adds a conversation item to the correct thread bucket', () => {
      const snap = snapshot()
      const { applyDaemonEvent } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(snap))

      const msg = assistantMessage('msg-1', 'Hello world')
      applyDaemonEvent(conversationItemAddedEvent(msg))

      const items = useSessionStore.getState().threadItems['thread-1']
      expect(items).toHaveLength(1)
      expect(items![0]).toMatchObject({ id: 'msg-1', text: 'Hello world' })
    })

    it('upserts an existing item instead of duplicating', () => {
      const snap = snapshot()
      const { applyDaemonEvent } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(snap))

      const msg = assistantMessage('msg-1', 'initial')
      applyDaemonEvent(conversationItemAddedEvent(msg))
      expect(useSessionStore.getState().threadItems['thread-1']).toHaveLength(1)

      const updated = assistantMessage('msg-1', 'updated')
      applyDaemonEvent({
        seq: 3,
        emitted_at: '2026-03-16T10:02:00Z',
        workspace_id: 'workspace-1',
        thread_id: 'thread-1',
        event: { type: 'conversation-item-updated', item: updated },
      })

      const items = useSessionStore.getState().threadItems['thread-1']
      expect(items).toHaveLength(1)
      expect(items![0]).toMatchObject({ text: 'updated' })
    })

    it('updates threadDetail items when matching the active thread', () => {
      const snap = snapshot()
      const { applyDaemonEvent, setThreadDetail } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(snap))
      setThreadDetail(threadDetail({ thread: thread(), items: [] }))

      const msg = assistantMessage('msg-1', 'Hello')
      applyDaemonEvent(conversationItemAddedEvent(msg))

      const detail = useSessionStore.getState().threadDetail
      expect(detail?.items).toHaveLength(1)
      expect(detail?.items[0]).toMatchObject({ id: 'msg-1' })
    })

    it('does not affect threadDetail for a different thread', () => {
      const snap = snapshot()
      const { applyDaemonEvent, setThreadDetail } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(snap))
      setThreadDetail(threadDetail())

      const msg = assistantMessage('msg-1', 'Hello')
      applyDaemonEvent(conversationItemAddedEvent(msg, 'other-thread'))

      expect(useSessionStore.getState().threadDetail?.items).toHaveLength(0)
    })
  })

  describe('selectThread / selectWorkspace', () => {
    it('sets both workspace and thread when selecting a thread', () => {
      const { selectThread } = useSessionStore.getState()
      selectThread('w1', 't1')

      const state = useSessionStore.getState()
      expect(state.selectedWorkspaceId).toBe('w1')
      expect(state.selectedThreadId).toBe('t1')
    })

    it('selectWorkspace falls back to workspace.current_thread_id', () => {
      const snap = snapshot({
        workspaces: [workspace({ id: 'w1', current_thread_id: 'auto-thread' })],
        threads: [thread({ id: 'auto-thread', workspace_id: 'w1' })],
      })
      const { applyDaemonEvent, selectWorkspace } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(snap))
      selectWorkspace('w1')

      expect(useSessionStore.getState().selectedThreadId).toBe('auto-thread')
    })

    it('clears stale threadDetail when selecting a different thread', () => {
      const { setThreadDetail, selectThread } = useSessionStore.getState()
      setThreadDetail(threadDetail({ thread: thread({ id: 't-existing' }) }))

      selectThread('w1', 't-next')

      expect(useSessionStore.getState().threadDetail).toBeNull()
    })

    it('selectNewThread keeps the workspace but clears thread selection and detail', () => {
      const { setThreadDetail, selectNewThread } = useSessionStore.getState()
      setThreadDetail(threadDetail())

      selectNewThread('workspace-1')

      const state = useSessionStore.getState()
      expect(state.selectedWorkspaceId).toBe('workspace-1')
      expect(state.selectedThreadId).toBeNull()
      expect(state.threadDetail).toBeNull()
    })
  })

  describe('setThreadDetail', () => {
    it('merges items from detail with existing threadItems bucket', () => {
      const { applyDaemonEvent, setThreadDetail } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(snapshot()))

      // Pre-populate bucket with a streaming item
      applyDaemonEvent(conversationItemAddedEvent(assistantMessage('msg-1', 'streaming')))

      // Then set thread detail with overlapping + new items
      setThreadDetail(
        threadDetail({
          items: [
            assistantMessage('msg-1', 'finalized'),
            userMessage('msg-0', 'user input', '2026-03-16T09:59:00Z'),
          ],
        }),
      )

      const items = useSessionStore.getState().threadItems['thread-1']
      expect(items).toHaveLength(2)
      // msg-1 should be updated (upserted)
      expect(items!.find((i) => i.id === 'msg-1')).toMatchObject({ kind: 'assistant_message' })
    })

    it('does not replace the active thread detail with a stale response for another thread', () => {
      const { setThreadDetail, selectThread } = useSessionStore.getState()
      selectThread('workspace-1', 'thread-2')
      setThreadDetail(threadDetail({ thread: thread({ id: 'thread-2' }) }))

      setThreadDetail(
        threadDetail({
          thread: thread({ id: 'thread-1' }),
          items: [assistantMessage('stale-msg', 'late response')],
        }),
      )

      const state = useSessionStore.getState()
      expect(state.threadDetail?.thread.id).toBe('thread-2')
      expect(state.threadItems['thread-1']).toEqual([
        expect.objectContaining({ id: 'stale-msg', text: 'late response' }),
      ])
    })

    it('clears threadDetail when passed null', () => {
      const { setThreadDetail, selectThread } = useSessionStore.getState()
      selectThread('workspace-1', 'thread-1')
      setThreadDetail(threadDetail())
      expect(useSessionStore.getState().threadDetail).toBeTruthy()

      setThreadDetail(null)
      expect(useSessionStore.getState().threadDetail).toBeNull()
    })

    it('prepends older pages without dropping the cached tail window', () => {
      const { selectThread, setThreadDetail } = useSessionStore.getState()
      selectThread('workspace-1', 'thread-1')

      setThreadDetail(threadDetail({
        items: [
          assistantMessage('msg-2', 'second'),
          assistantMessage('msg-3', 'third'),
        ],
        has_older: true,
        oldest_item_id: 'msg-2',
        newest_item_id: 'msg-3',
        is_partial: true,
      }))

      setThreadDetail(
        threadDetail({
          items: [
            userMessage('msg-0', 'first'),
            assistantMessage('msg-1', 'one'),
          ],
          has_older: false,
          oldest_item_id: 'msg-0',
          newest_item_id: 'msg-1',
          is_partial: true,
        }),
        { mergeMode: 'prepend' },
      )

      const state = useSessionStore.getState()
      expect(state.threadDetail?.items.map((item) => item.id)).toEqual([
        'msg-0',
        'msg-1',
        'msg-2',
        'msg-3',
      ])
      expect(state.threadHistory['thread-1']).toMatchObject({
        hasOlder: false,
        oldestItemId: 'msg-0',
        newestItemId: 'msg-3',
        isPartial: true,
      })
    })
  })

  describe('mobile cache', () => {
    it('filters archived threads and archived approvals from snapshot state', () => {
      useSessionStore.getState().applyDaemonEvent(
        snapshotEvent(snapshot({
          workspaces: [workspace({ id: 'workspace-1', current_thread_id: 'thread-1' })],
          threads: [
            thread({ id: 'thread-1', workspace_id: 'workspace-1', is_archived: false }),
            thread({ id: 'thread-archived', workspace_id: 'workspace-1', is_archived: true }),
          ],
          interactive_requests: [
            approval({ request_id: 'approval-active', thread_id: 'thread-1' }),
            approval({ request_id: 'approval-archived', thread_id: 'thread-archived' }),
          ],
        })),
      )

      const state = useSessionStore.getState()
      expect(state.snapshot?.threads.map((entry) => entry.id)).toEqual(['thread-1'])
      expect(state.snapshot?.interactive_requests.map((entry) => entry.request_id)).toEqual([
        'approval-active',
      ])
    })

    it('hydrates cached snapshot selection and cached thread history', () => {
      const { applyDaemonEvent, exportCache, selectThread, setThreadDetail } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(snapshot({
        workspaces: [workspace({ id: 'workspace-1', current_thread_id: 'thread-1' })],
        threads: [thread({ id: 'thread-1', workspace_id: 'workspace-1' })],
      })))
      selectThread('workspace-1', 'thread-1')
      setThreadDetail(threadDetail({
        items: [
          userMessage('msg-0', 'hello'),
          assistantMessage('msg-1', 'world'),
        ],
        has_older: true,
        oldest_item_id: 'msg-0',
        newest_item_id: 'msg-1',
        is_partial: true,
      }))

      const cache = exportCache()
      expect(cache).toBeTruthy()

      useSessionStore.getState().reset()
      useSessionStore.getState().hydrateCache(cache!)

      const state = useSessionStore.getState()
      expect(state.selectedWorkspaceId).toBe('workspace-1')
      expect(state.selectedThreadId).toBe('thread-1')
      expect(state.snapshot?.threads.map((entry) => entry.id)).toEqual(['thread-1'])
      expect(state.threadItems['thread-1']?.map((item) => item.id)).toEqual(['msg-0', 'msg-1'])
      expect(state.threadHistory['thread-1']).toMatchObject({
        hasOlder: true,
        oldestItemId: 'msg-0',
        newestItemId: 'msg-1',
        isPartial: true,
      })
    })

    it('drops cached thread histories for threads outside the active snapshot', () => {
      useSessionStore.getState().hydrateCache({
        version: MOBILE_SESSION_CACHE_VERSION,
        snapshot: snapshot({
          workspaces: [workspace({ id: 'workspace-1', current_thread_id: 'thread-1' })],
          threads: [thread({ id: 'thread-1', workspace_id: 'workspace-1' })],
        }),
        selectedWorkspaceId: 'workspace-1',
        selectedThreadId: 'thread-1',
        recentThreadIds: ['thread-1', 'thread-archived'],
        threadHistories: {
          'thread-1': {
            thread_id: 'thread-1',
            items: [assistantMessage('msg-1', 'hello')],
            has_older: false,
            oldest_item_id: 'msg-1',
            newest_item_id: 'msg-1',
            is_partial: true,
            updated_at: '2026-03-16T10:00:00Z',
          },
          'thread-archived': {
            thread_id: 'thread-archived',
            items: [assistantMessage('msg-hidden', 'hidden')],
            has_older: false,
            oldest_item_id: 'msg-hidden',
            newest_item_id: 'msg-hidden',
            is_partial: true,
            updated_at: '2026-03-16T10:00:00Z',
          },
        },
      })

      const state = useSessionStore.getState()
      expect(Object.keys(state.threadItems)).toEqual(['thread-1'])
      expect(Object.keys(state.threadHistory)).toEqual(['thread-1'])
    })
  })

  describe('derived selector logic', () => {
    it('clears stale thread detail when snapshot reconciliation changes the selection', () => {
      const snap = snapshot({
        workspaces: [workspace({ id: 'workspace-1', current_thread_id: 'thread-1' })],
        threads: [thread({ id: 'thread-1', workspace_id: 'workspace-1' })],
      })
      const { applyDaemonEvent, selectThread } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(snap))
      selectThread('workspace-1', 'thread-1')
      useSessionStore.getState().setThreadDetail(threadDetail())

      applyDaemonEvent(
        snapshotEvent(
          snapshot({
            workspaces: [workspace({ id: 'workspace-1', current_thread_id: null })],
            threads: [],
          }),
        ),
      )

      const state = useSessionStore.getState()
      expect(state.selectedThreadId).toBeNull()
      expect(state.threadDetail).toBeNull()
    })

    it('buildProjectGroups groups threads by workspace from snapshot', () => {
      const snap = snapshot({
        workspaces: [workspace({ id: 'w1', path: '/tmp/alpha' })],
        threads: [thread({ id: 't1', workspace_id: 'w1' }), thread({ id: 't2', workspace_id: 'w1' })],
      })
      useSessionStore.getState().applyDaemonEvent(snapshotEvent(snap))

      const s = useSessionStore.getState()
      const groups = buildProjectGroups(s.snapshot!.workspaces, s.snapshot!.threads)
      expect(groups).toHaveLength(1)
      expect(groups[0].workspace.id).toBe('w1')
      expect(groups[0].threads).toHaveLength(2)
    })

    it('conversation items come from threadDetail when it exists', () => {
      const { setThreadDetail, selectThread } = useSessionStore.getState()
      selectThread('workspace-1', 'thread-1')

      setThreadDetail(
        threadDetail({
          items: [assistantMessage('a', 'hello'), userMessage('b', 'hi')],
        }),
      )

      const s = useSessionStore.getState()
      expect(s.threadDetail?.items).toHaveLength(2)
    })

    it('conversation items fall back to threadItems bucket when no detail', () => {
      const { applyDaemonEvent, selectThread } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(snapshot()))
      selectThread('workspace-1', 'thread-1')

      applyDaemonEvent(conversationItemAddedEvent(assistantMessage('a', 'hello')))

      const s = useSessionStore.getState()
      expect(s.threadItems['thread-1']).toHaveLength(1)
    })

    it('approvals can be filtered by selected thread', () => {
      const snap = snapshot({
        interactive_requests: [
          approval({ request_id: 'a1', thread_id: 'thread-1' }),
          approval({ request_id: 'a2', thread_id: 'thread-2' }),
        ],
      })
      const { applyDaemonEvent, selectThread } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(snap))
      selectThread('workspace-1', 'thread-1')

      const s = useSessionStore.getState()
      const filtered = (s.snapshot?.interactive_requests ?? []).filter(
        (a) => !s.selectedThreadId || a.thread_id === s.selectedThreadId,
      )
      expect(filtered).toHaveLength(1)
      expect(filtered[0].request_id).toBe('a1')
    })
  })

  describe('reset', () => {
    it('clears all state back to initial values', () => {
      const { applyDaemonEvent, selectThread, reset } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(snapshot()))
      selectThread('w1', 't1')
      expect(useSessionStore.getState().snapshot).toBeTruthy()

      reset()
      const state = useSessionStore.getState()
      expect(state.snapshot).toBeNull()
      expect(state.selectedWorkspaceId).toBeNull()
      expect(state.selectedThreadId).toBeNull()
      expect(state.threadItems).toEqual({})
    })
  })
})
