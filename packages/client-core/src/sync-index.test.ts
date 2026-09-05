import { describe, expect, it } from 'vitest'
import { normalizeDaemonSnapshot, normalizeThreadSummary } from './normalization'
import { expandSyncIndex, mergeSyncExtensions, mergeSyncThreadPage, trackSyncIndexEvent, type SyncIndex } from './sync-index'
import type { EventEnvelope } from './types'

function base() {
  return expandSyncIndex({ token: 'one', snapshot: normalizeDaemonSnapshot({ daemon: { version: 'test', started_at: '2026-09-05T12:00:00Z' } }),
    agent_catalogs: [], workspace_agents: {}, model_catalogs: [], workspace_models: {}, counts: {} } as SyncIndex)
}
const thread = normalizeThreadSummary({ id: 'one', workspace_id: 'workspace', title: 'Old', status: 'idle' })
function event(body: EventEnvelope['event']): EventEnvelope {
  return { seq: 1, emitted_at: '2026-09-05T12:00:00Z', workspace_id: 'workspace', thread_id: 'one', event: body }
}

describe('compact index coverage', () => {
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
