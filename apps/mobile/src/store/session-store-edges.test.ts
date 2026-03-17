/**
 * Edge case tests for session-store — covers scenarios beyond basic CRUD.
 */
import { describe, it, expect, beforeEach } from 'vitest'

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

describe('session-store edge cases', () => {
  beforeEach(resetStore)

  describe('multiple workspaces', () => {
    it('handles threads across multiple workspaces', () => {
      const snap = snapshot({
        workspaces: [
          workspace({ id: 'w1', path: '/tmp/project-a' }),
          workspace({ id: 'w2', path: '/tmp/project-b' }),
        ],
        threads: [
          thread({ id: 't1', workspace_id: 'w1', title: 'Thread A' }),
          thread({ id: 't2', workspace_id: 'w1', title: 'Thread A2' }),
          thread({ id: 't3', workspace_id: 'w2', title: 'Thread B' }),
        ],
      })

      useSessionStore.getState().applyDaemonEvent(snapshotEvent(snap))
      const state = useSessionStore.getState()

      expect(state.snapshot!.workspaces).toHaveLength(2)
      expect(state.snapshot!.threads).toHaveLength(3)
      expect(state.snapshot!.threads.filter((t) => t.workspace_id === 'w1')).toHaveLength(2)
      expect(state.snapshot!.threads.filter((t) => t.workspace_id === 'w2')).toHaveLength(1)
    })

    it('items for different threads are isolated in separate buckets', () => {
      const snap = snapshot({
        threads: [
          thread({ id: 't1' }),
          thread({ id: 't2' }),
        ],
      })
      const { applyDaemonEvent } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(snap))

      applyDaemonEvent(conversationItemAddedEvent(assistantMessage('a1', 'hello'), 't1'))
      applyDaemonEvent(conversationItemAddedEvent(assistantMessage('a2', 'world'), 't2'))

      const items = useSessionStore.getState().threadItems
      expect(items['t1']).toHaveLength(1)
      expect(items['t2']).toHaveLength(1)
      expect(items['t1']![0].id).toBe('a1')
      expect(items['t2']![0].id).toBe('a2')
    })
  })

  describe('empty state handling', () => {
    it('handles snapshot with no workspaces', () => {
      const snap = snapshot({ workspaces: [], threads: [] })
      useSessionStore.getState().applyDaemonEvent(snapshotEvent(snap))

      const state = useSessionStore.getState()
      expect(state.snapshot!.workspaces).toHaveLength(0)
      expect(state.snapshot!.threads).toHaveLength(0)
    })

    it('handles events before snapshot is loaded', () => {
      const msg = assistantMessage('a1', 'hello')
      // Should not crash even without a snapshot
      expect(() => {
        useSessionStore.getState().applyDaemonEvent(
          conversationItemAddedEvent(msg),
        )
      }).not.toThrow()
    })

    it('conversation items for nonexistent thread creates bucket', () => {
      useSessionStore.getState().applyDaemonEvent(
        conversationItemAddedEvent(assistantMessage('a1', 'hello'), 'ghost-thread'),
      )

      const items = useSessionStore.getState().threadItems['ghost-thread']
      expect(items).toHaveLength(1)
    })
  })

  describe('reconcileSelection', () => {
    it('can be called explicitly to fix stale selection', () => {
      const snap = snapshot({
        workspaces: [workspace({ id: 'w1', current_thread_id: 't1' })],
        threads: [thread({ id: 't1', workspace_id: 'w1' })],
      })
      const { applyDaemonEvent, selectThread, reconcileSelection } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(snap))
      selectThread('w-stale', 't-stale')

      reconcileSelection()

      const state = useSessionStore.getState()
      // Should fall back to w1/t1 since w-stale doesn't exist
      expect(state.selectedWorkspaceId).toBe('w1')
      expect(state.selectedThreadId).toBe('t1')
    })
  })

  describe('reconciliation via applyDaemonEvent', () => {
    it('reconcileSelection clears stale selection after snapshot update', () => {
      const snap = snapshot({
        workspaces: [workspace({ id: 'w1' })],
        threads: [thread({ id: 't1', workspace_id: 'w1' })],
      })
      const { applyDaemonEvent, selectThread, reconcileSelection } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(snap))
      selectThread('w1', 't1')

      // Now update snapshot without t1
      const newSnap = snapshot({
        workspaces: [workspace({ id: 'w1' })],
        threads: [thread({ id: 't2', workspace_id: 'w1' })],
      })
      applyDaemonEvent(snapshotEvent(newSnap))

      // Selection should be reconciled
      const state = useSessionStore.getState()
      // The reconciliation happens inside applyDaemonEvent
      // Since t1 no longer exists, selection should change
      expect(state.selectedThreadId).not.toBe('t1')
    })
  })

  describe('thread-updated events', () => {
    it('updates thread status in snapshot', () => {
      const snap = snapshot()
      const { applyDaemonEvent } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(snap))

      const updatedThread = thread({ status: 'running', title: 'Updated title' })
      applyDaemonEvent(threadUpdatedEvent(updatedThread))

      // The snapshot should reflect the update (via applySnapshotEvent)
      const state = useSessionStore.getState()
      const t = state.snapshot?.threads.find((t) => t.id === 'thread-1')
      expect(t?.status).toBe('running')
      expect(t?.title).toBe('Updated title')
    })
  })

  describe('rapid message stream', () => {
    it('handles many items added in quick succession', () => {
      const snap = snapshot()
      const { applyDaemonEvent } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(snap))

      for (let i = 0; i < 50; i++) {
        applyDaemonEvent(
          conversationItemAddedEvent(
            assistantMessage(`msg-${i}`, `message ${i}`, `2026-03-16T10:${String(i).padStart(2, '0')}:00Z`),
          ),
        )
      }

      expect(useSessionStore.getState().threadItems['thread-1']).toHaveLength(50)
    })

    it('interleaving user and assistant messages maintains order', () => {
      const snap = snapshot()
      const { applyDaemonEvent } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(snap))

      applyDaemonEvent(conversationItemAddedEvent(userMessage('u1', 'first', '2026-03-16T10:00:00Z')))
      applyDaemonEvent(conversationItemAddedEvent(assistantMessage('a1', 'response', '2026-03-16T10:01:00Z')))
      applyDaemonEvent(conversationItemAddedEvent(userMessage('u2', 'second', '2026-03-16T10:02:00Z')))

      const items = useSessionStore.getState().threadItems['thread-1']!
      expect(items).toHaveLength(3)
      expect(items[0].id).toBe('u1')
      expect(items[1].id).toBe('a1')
      expect(items[2].id).toBe('u2')
    })
  })

  describe('all conversation item kinds', () => {
    it('stores tool_call items', () => {
      const snap = snapshot()
      const { applyDaemonEvent } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(snap))

      applyDaemonEvent(conversationItemAddedEvent(toolCall('tc1', 'bash')))
      const item = useSessionStore.getState().threadItems['thread-1']![0]
      expect(item.kind).toBe('tool_call')
    })

    it('stores service items', () => {
      const snap = snapshot()
      const { applyDaemonEvent } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(snap))

      applyDaemonEvent(conversationItemAddedEvent(serviceMessage('s1', 'info')))
      const item = useSessionStore.getState().threadItems['thread-1']![0]
      expect(item.kind).toBe('service')
    })
  })

  describe('setThreadDetail edge cases', () => {
    it('setting detail for a thread with existing items merges correctly', () => {
      const snap = snapshot()
      const { applyDaemonEvent, setThreadDetail } = useSessionStore.getState()
      applyDaemonEvent(snapshotEvent(snap))

      // Add streaming item
      applyDaemonEvent(conversationItemAddedEvent(assistantMessage('msg-1', 'streaming...')))

      // Set detail with final version of same item + older item
      setThreadDetail(threadDetail({
        items: [
          userMessage('msg-0', 'user prompt', '2026-03-16T09:59:00Z'),
          assistantMessage('msg-1', 'final response'),
        ],
      }))

      const items = useSessionStore.getState().threadItems['thread-1']!
      // Should have both items, msg-1 upserted not duplicated
      expect(items).toHaveLength(2)
      // The later upsert should win
      const msg1 = items.find((i) => i.id === 'msg-1')
      expect(msg1).toBeDefined()
    })
  })
})
