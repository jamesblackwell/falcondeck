import type { DaemonSnapshot, EventEnvelope, ExtensionSnapshot, ModelSummary, ThreadSummary, WorkspaceAgentSummary } from './types'

export type WorkspaceIndexCount = { total: number; running: number; unread: number; awaiting: number }
export type SyncIndex = {
  token: string
  snapshot: DaemonSnapshot
  agent_catalogs: WorkspaceAgentSummary[]
  workspace_agents: Record<string, number[]>
  model_catalogs: ModelSummary[][]
  workspace_models: Record<string, number>
  counts: Record<string, WorkspaceIndexCount>
}
export type SyncThreadPage = { token: string; workspace_id: string; threads: ThreadSummary[]; next_cursor: number | null }
/** Client-owned coverage of a frozen index. Never interchangeable with relay seq. */
export type SyncIndexCoverage = {
  token: string
  counts: Record<string, WorkspaceIndexCount>
  cursors: Record<string, number | null>
  touched_threads: Record<string, true>
  touched_views: Record<string, true>
  catalog_touched: boolean
  extensions_loaded: boolean
}

export function expandSyncIndex(index: SyncIndex): DaemonSnapshot {
  if (!index.token || !Array.isArray(index.agent_catalogs) || !Array.isArray(index.model_catalogs)) throw new Error('Invalid compact sync index')
  return {
    ...index.snapshot,
    workspaces: index.snapshot.workspaces.map(workspace => ({
      ...workspace,
      agents: (index.workspace_agents[workspace.id] ?? []).map(id => {
        const catalog = index.agent_catalogs[id]
        if (!catalog) throw new Error('Missing sync agent catalog')
        return catalog
      }),
      models: index.model_catalogs[index.workspace_models[workspace.id]] ?? [],
    })),
    sync_index: { token: index.token, counts: index.counts, cursors: {}, touched_threads: {}, touched_views: {}, catalog_touched: false, extensions_loaded: false },
  }
}

export function syncViewKey(view: { extension_id: string; view_id: string; scope?: { kind: string; id: string } | null }) {
  return JSON.stringify([view.extension_id, view.view_id, view.scope?.kind, view.scope?.id])
}

/** Remember changes after the base so a late page cannot revive archived rows
 * or overwrite newer state, including events raced against the initial RPC. */
export function trackSyncIndexEvent(snapshot: DaemonSnapshot, event: EventEnvelope): DaemonSnapshot {
  const index = snapshot.sync_index
  if (!index) return snapshot
  const body = event.event
  if (body.type === 'thread-updated' || body.type === 'thread-started') {
    const previous = snapshot.threads.find(thread => thread.id === body.thread.id)
    const current = body.thread
    const counts = { ...index.counts }
    // The base already counts unseen rows. Only adjust membership we can prove.
    if (previous && previous.updated_at <= current.updated_at) {
      const count = counts[current.workspace_id]
      if (count) {
        const active = (thread: ThreadSummary) => Number(!thread.is_archived)
        const running = (thread: ThreadSummary) => active(thread) * Number(thread.status === 'running')
        const unread = (thread: ThreadSummary) => active(thread) * Number(thread.attention.unread)
        const awaiting = (thread: ThreadSummary) => active(thread) * Number(thread.attention.pending_approval_count + thread.attention.pending_question_count > 0)
        counts[current.workspace_id] = {
          total: Math.max(0, count.total + active(current) - active(previous)),
          running: Math.max(0, count.running + running(current) - running(previous)),
          unread: Math.max(0, count.unread + unread(current) - unread(previous)),
          awaiting: Math.max(0, count.awaiting + awaiting(current) - awaiting(previous)),
        }
      }
    }
    return { ...snapshot, sync_index: { ...index, counts, touched_threads: { ...index.touched_threads, [current.id]: true } } }
  }
  if (body.type === 'extension-view-updated') {
    return { ...snapshot, sync_index: { ...index, touched_views: { ...index.touched_views, [syncViewKey(body)]: true } } }
  }
  if (body.type === 'extension-catalog-updated') return { ...snapshot, sync_index: { ...index, catalog_touched: true } }
  return snapshot
}

export function mergeSyncThreadPage(snapshot: DaemonSnapshot, page: SyncThreadPage, sort: string): DaemonSnapshot {
  const index = snapshot.sync_index
  if (!index || index.token !== page.token) return snapshot
  const rows = new Map(snapshot.threads.map(thread => [thread.id, thread]))
  for (const thread of page.threads) {
    if (thread.workspace_id !== page.workspace_id) throw new Error('Sync page scope mismatch')
    if (!index.touched_threads[thread.id] && !rows.has(thread.id)) rows.set(thread.id, thread)
  }
  return { ...snapshot, threads: [...rows.values()], sync_index: { ...index, cursors: { ...index.cursors, [`${page.workspace_id}:${sort}`]: page.next_cursor } } }
}

export function mergeSyncExtensions(snapshot: DaemonSnapshot, token: string, extensions: ExtensionSnapshot): DaemonSnapshot {
  const index = snapshot.sync_index
  if (!index || index.token !== token) return snapshot
  const views = new Map(snapshot.extensions.views.map(view => [syncViewKey(view), view]))
  for (const view of extensions.views) if (!index.touched_views[syncViewKey(view)]) views.set(syncViewKey(view), view)
  return {
    ...snapshot,
    extensions: { catalog: index.catalog_touched ? snapshot.extensions.catalog : extensions.catalog, views: [...views.values()] },
    sync_index: { ...index, extensions_loaded: true },
  }
}
