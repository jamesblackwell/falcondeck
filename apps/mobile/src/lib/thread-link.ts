import { normalizeDaemonSnapshot, resolveThreadLinkTarget, type DaemonSnapshot } from '@falcondeck/client-core'

import { useRelayStore } from '@/store/relay-store'
import { useSessionStore } from '@/store/session-store'

let latestRequest = 0
const ARCHIVED_TASK_MESSAGE = 'This task is archived. Restore it on your computer to open it.'

/** A cache miss is normal with the compact task index; resolve it on its daemon. */
export async function openThreadLink(threadId: string): Promise<boolean> {
  const request = ++latestRequest
  const relay = useRelayStore.getState()
  const sessionId = relay.sessionId
  const socket = relay._getSocket()
  const crypto = relay._getSessionCrypto()
  let cancelled = false
  const unsubscribe = useSessionStore.subscribe((state, previous) => {
    if (state.selectedThreadId !== previous.selectedThreadId ||
        state.selectedWorkspaceId !== previous.selectedWorkspaceId) cancelled = true
  })
  const isCurrent = () => {
    const current = useRelayStore.getState()
    return !cancelled && request === latestRequest && current.sessionId === sessionId &&
      current._getSocket() === socket && current._getSessionCrypto() === crypto
  }

  try {
    let target = resolveThreadLinkTarget(threadId, useSessionStore.getState().snapshot?.threads ?? [])
    if (target?.is_archived) throw new Error(ARCHIVED_TASK_MESSAGE)
    if (!target) {
      let raw: DaemonSnapshot
      try {
        raw = await relay._callRpc<DaemonSnapshot>('snapshot.current', {
          include_archived_threads: true,
          include_thread_plans: false,
          include_thread_diffs: false,
          include_agent_skills: false,
          include_workspace_skills: false,
        }, { requestIdPrefix: 'mobile-task-link' })
      } catch {
        if (!isCurrent()) return false
        throw new Error('Could not load this task. Check your connection and try again.')
      }
      if (!isCurrent()) return false
      const resolved = normalizeDaemonSnapshot(raw)
      const session = useSessionStore.getState()
      target = resolveThreadLinkTarget(threadId, session.snapshot?.threads ?? []) ??
        resolveThreadLinkTarget(threadId, resolved.threads)
      if (!target) throw new Error('This task is no longer available on your computer.')
      if (target.is_archived) throw new Error(ARCHIVED_TASK_MESSAGE)
      const workspaceId = target.workspace_id
      const workspace = session.snapshot?.workspaces.find(entry => entry.id === workspaceId) ??
        resolved.workspaces.find(entry => entry.id === workspaceId)
      if (!workspace || !session.snapshot) throw new Error('The project for this task is no longer available.')
      // Keep compact-index coverage, catalogs and live events; insert only the destination.
      if (!session.snapshot.workspaces.some(entry => entry.id === workspace.id)) {
        useSessionStore.setState(state => state.snapshot ? {
          snapshot: { ...state.snapshot, workspaces: [...state.snapshot.workspaces, workspace] },
        } : state)
      }
      useSessionStore.getState().applyThreadHandle({ workspace, thread: target })
    }
    if (!isCurrent()) return false
    useSessionStore.getState().selectThread(target.workspace_id, target.id)
    return true
  } finally {
    unsubscribe()
  }
}
