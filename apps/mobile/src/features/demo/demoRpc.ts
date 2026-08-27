/**
 * Local stand-in for the daemon while the app is in demo mode.
 *
 * Demo mode has no relay socket and no session key, so every `_callRpc` would
 * otherwise reject with an encryption error. This answers the calls the demo
 * workspace actually makes — including a canned assistant reply, so the app
 * responds to a sent message with no desktop paired — and refuses the rest
 * with a sentence that explains why instead of a transport failure.
 */
import type {
  ConversationItem,
  ThreadHandle,
  ThreadStatus,
  ThreadSummary,
} from '@falcondeck/client-core'

import { useSessionStore } from '@/store/session-store'

import {
  DEMO_AGENT,
  DEMO_ASSISTANT_REPLY,
  DEMO_SESSION_ID,
  demoWorkspace,
  makeAttention,
} from './demoData'

export const DEMO_UNAVAILABLE_MESSAGE =
  'That needs a paired desktop. Connect FalconDeck on your Mac to use it.'

// Long enough to read as the agent thinking, short enough that a reviewer
// tapping send never wonders whether the app is stuck.
const DEMO_REPLY_DELAY_MS = 900

const DEMO_REPLY_PREVIEW = 'Hello — this is a response from the demo workspace.'

let demoIdCounter = 0
const nextDemoId = (prefix: string) => `${prefix}-${Date.now()}-${demoIdCounter++}`

export function isDemoSession(sessionId: string | null): boolean {
  return sessionId === DEMO_SESSION_ID
}

function stringParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key]
  return typeof value === 'string' ? value : null
}

function patchThread(threadId: string, patch: Partial<ThreadSummary>): ThreadSummary {
  const session = useSessionStore.getState()
  const thread = session.snapshot?.threads.find((entry) => entry.id === threadId)
  if (!thread) throw new Error(DEMO_UNAVAILABLE_MESSAGE)
  const next = { ...thread, ...patch }
  session.applyThreadSummary(next)
  return next
}

function newDemoThread(): ThreadSummary {
  return {
    id: nextDemoId('demo-thread'),
    workspace_id: demoWorkspace.id,
    title: 'New conversation',
    provider: 'claude',
    status: 'idle',
    updated_at: new Date().toISOString(),
    last_message_preview: null,
    latest_turn_id: null,
    latest_plan: null,
    latest_diff: null,
    last_tool: null,
    last_error: null,
    agent: DEMO_AGENT,
    attention: makeAttention(0),
    is_archived: false,
    is_pinned: false,
    is_pinned_in_project: false,
    goal: null,
    queued_turns: [],
    variant: null,
  }
}

const pendingReplies = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleDemoReply(threadId: string) {
  cancelDemoReply(threadId)
  patchThread(threadId, { status: 'running', updated_at: new Date().toISOString() })
  const timer = setTimeout(() => {
    pendingReplies.delete(threadId)
    const reply: ConversationItem = {
      kind: 'assistant_message',
      id: nextDemoId('demo-reply'),
      text: DEMO_ASSISTANT_REPLY,
      created_at: new Date().toISOString(),
    }
    useSessionStore.getState().upsertLocalThreadItem(threadId, reply)
    patchThread(threadId, {
      status: 'idle',
      updated_at: new Date().toISOString(),
      last_message_preview: DEMO_REPLY_PREVIEW,
    })
  }, DEMO_REPLY_DELAY_MS)
  pendingReplies.set(threadId, timer)
}

/** Stop is expected to stop: without this the reply still lands after it. */
function cancelDemoReply(threadId: string) {
  const timer = pendingReplies.get(threadId)
  if (!timer) return
  clearTimeout(timer)
  pendingReplies.delete(threadId)
}

function markedThread(threadId: string, unread: boolean): ThreadSummary {
  return patchThread(threadId, {
    attention: { ...makeAttention(0), unread, level: unread ? 'unread' : 'none' },
  })
}

function updatedThread(params: Record<string, unknown>, threadId: string): ThreadHandle {
  const patch: Partial<ThreadSummary> = {}
  if (typeof params.title === 'string') patch.title = params.title
  if (typeof params.pinned === 'boolean') patch.is_pinned = params.pinned
  if (typeof params.pinned_in_project === 'boolean') {
    patch.is_pinned_in_project = params.pinned_in_project
  }
  return { workspace: demoWorkspace, thread: patchThread(threadId, patch) }
}

function demoStatus(threadId: string, status: ThreadStatus) {
  patchThread(threadId, { status, updated_at: new Date().toISOString() })
}

/**
 * Preference screens replace the snapshot with whatever this returns, so the
 * patch has to come back merged into the full stored object rather than alone.
 */
function mergedPreferences(params: Record<string, unknown>): Record<string, unknown> {
  const current = (useSessionStore.getState().snapshot?.preferences ?? {}) as Record<string, unknown>
  const merged: Record<string, unknown> = { ...current }
  for (const [section, patch] of Object.entries(params)) {
    const existing = current[section]
    merged[section] =
      patch && typeof patch === 'object' && existing && typeof existing === 'object'
        ? { ...existing, ...patch }
        : patch
  }
  return merged
}

export async function handleDemoRpc<T>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const threadId = stringParam(params, 'thread_id')

  switch (method) {
    case 'thread.start':
      return { workspace: demoWorkspace, thread: newDemoThread() } as T

    case 'turn.start':
      if (!threadId) throw new Error(DEMO_UNAVAILABLE_MESSAGE)
      scheduleDemoReply(threadId)
      return { ok: true, message: null } as T

    case 'turn.interrupt':
      if (threadId) {
        cancelDemoReply(threadId)
        demoStatus(threadId, 'idle')
      }
      return { ok: true } as T

    case 'thread.mark_read':
    case 'thread.mark_unread':
      if (!threadId) throw new Error(DEMO_UNAVAILABLE_MESSAGE)
      return markedThread(threadId, method === 'thread.mark_unread') as T

    case 'thread.update':
      if (!threadId) throw new Error(DEMO_UNAVAILABLE_MESSAGE)
      return updatedThread(params, threadId) as T

    // The caller already dropped the thread locally; there is nothing behind
    // the demo workspace to confirm it against.
    case 'thread.archive':
      return { ok: true } as T

    // There is one workspace in the demo; "new chat" opens a thread in it.
    case 'chat.create':
      return demoWorkspace as T

    case 'preferences.update':
      return mergedPreferences(params) as T

    case 'workspace.skills':
      return { skills: [] } as T

    case 'control.get':
      return { resource: String(params.resource ?? ''), data: [] } as T

    case 'provider.hydrate':
      return { ok: true } as T

    default:
      throw new Error(DEMO_UNAVAILABLE_MESSAGE)
  }
}
