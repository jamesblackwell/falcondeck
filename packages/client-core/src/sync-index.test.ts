import { describe, expect, it } from 'vitest'
import { normalizeDaemonSnapshot, normalizeThreadSummary } from './normalization'
import { expandSyncIndex, mergeSyncExtensions, mergeSyncThreadPage, trackSyncIndexEvent, type SyncIndex } from './sync-index'
import type { EventEnvelope } from './types'
import { applySnapshotEvent } from './snapshot'

function base() {
  return expandSyncIndex({ token: 'one', snapshot: normalizeDaemonSnapshot({ daemon: { version: 'test', started_at: '2026-09-05T12:00:00Z' } }),
    agent_catalogs: [], workspace_agents: {}, model_catalogs: [], workspace_models: {}, counts: {} } as SyncIndex)
}
const thread = normalizeThreadSummary({ id: 'one', workspace_id: 'workspace', title: 'Old', status: 'idle' })
function event(body: EventEnvelope['event']): EventEnvelope {
  return { seq: 1, emitted_at: '2026-09-05T12:00:00Z', workspace_id: 'workspace', thread_id: 'one', event: body }
}

describe('compact index coverage', () => {
  it('preserves coverage identity after the first touch when counts do not change', () => {
    const snapshot = { ...base(), threads: [thread] }
    const touched = trackSyncIndexEvent(snapshot, event({ type: 'thread-updated', thread }))
    expect(touched.sync_index?.touched_threads.one).toBe(true)
    expect(touched.sync_index?.counts).toBe(snapshot.sync_index?.counts)
    expect(trackSyncIndexEvent(touched, event({ type: 'thread-updated', thread }))).toBe(touched)
  })

  it('counts an unread transition once even for a running thread', () => {
    const current = { ...thread, status: 'running' as const }
    const snapshot = { ...base(), threads: [current], sync_index: { ...base().sync_index!,
      counts: { workspace: { total: 1, running: 1, unread: 0, awaiting: 0 } } } }
    const unread = { ...current, attention: { ...current.attention, unread: true, last_agent_activity_seq: 1 },
      updated_at: '2026-09-29T10:00:00Z' }
    const updated = applySnapshotEvent(snapshot, event({ type: 'thread-updated', thread: unread }))!
    expect(updated.threads[0].attention.unread).toBe(true)
    expect(updated.sync_index?.counts.workspace.unread).toBe(1)
    const next = applySnapshotEvent(updated, event({ type: 'thread-updated', thread: {
      ...unread, updated_at: '2026-09-29T10:00:01Z',
    } }))!
    expect(next.sync_index).toBe(updated.sync_index)
    expect(next.sync_index?.counts.workspace.unread).toBe(1)
  })
  it('merges missing rows without deleting loaded rows or accepting another revision', () => {
    const snapshot = base()
    const page = { token: 'one', workspace_id: 'workspace', threads: [thread], next_cursor: null }
    expect(mergeSyncThreadPage(snapshot, { ...page, token: 'old' }, 'last_updated')).toBe(snapshot)
    const merged = mergeSyncThreadPage(snapshot, page, 'last_updated')
    expect(merged.threads).toEqual([thread])
    expect(mergeSyncThreadPage(merged, page, 'last_updated').threads).toHaveLength(1)
    expect(merged.sync_index?.cursors['workspace:last_updated']).toBeNull()
  })

  it('does not revive an unseen row archived after the base was captured', () => {
    const snapshot = trackSyncIndexEvent(base(), event({ type: 'thread-updated', thread: { ...thread, is_archived: true } }))
    const merged = mergeSyncThreadPage(snapshot, { token: 'one', workspace_id: 'workspace', threads: [thread], next_cursor: null }, 'last_updated')
    expect(merged.threads).toEqual([])
  })

  it('retains newer rows and rejects pages from another workspace', () => {
    const snapshot = { ...base(), threads: [{ ...thread, title: 'New' }] }
    const page = { token: 'one', workspace_id: 'workspace', threads: [thread], next_cursor: 1 }
    expect(mergeSyncThreadPage(snapshot, page, 'last_updated').threads[0].title).toBe('New')
    expect(() => mergeSyncThreadPage(snapshot, { ...page, workspace_id: 'wrong' }, 'last_updated')).toThrow('scope')
  })

  it('does not revive extension views deleted after the base', () => {
    const deletion = { type: 'extension-view-updated', extension_id: 'example', view_id: 'tags', scope: { kind: 'thread', id: 'one' }, view: null } as const
    const snapshot = trackSyncIndexEvent(base(), event(deletion))
    const view = { extension_id: 'example', view_id: 'tags', scope: deletion.scope } as never
    expect(mergeSyncExtensions(snapshot, 'one', { catalog: [], views: [view] }).extensions.views).toEqual([])
    expect(mergeSyncExtensions(snapshot, 'old', { catalog: [], views: [] })).toBe(snapshot)
  })
})
