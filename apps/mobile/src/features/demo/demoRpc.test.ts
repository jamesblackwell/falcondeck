import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSessionStore } from '@/store/session-store'
import { useRelayStore } from '@/store/relay-store'

import { demoSnapshot, demoThreadItems, DEMO_SESSION_ID } from './demoData'
import { DEMO_UNAVAILABLE_MESSAGE, handleDemoRpc, isDemoSession } from './demoRpc'

const THREAD_ID = 'demo-thread-1'

function seedDemoWorkspace() {
  const session = useSessionStore.getState()
  session.applyDaemonEvent({
    seq: 1,
    emitted_at: new Date().toISOString(),
    workspace_id: null,
    thread_id: null,
    event: { type: 'snapshot', snapshot: demoSnapshot },
  })
  session.selectThread('demo-workspace', THREAD_ID)
  const items = demoThreadItems[THREAD_ID]!
  session.setThreadDetail({
    workspace: demoSnapshot.workspaces[0]!,
    thread: demoSnapshot.threads[0]!,
    items,
    has_older: false,
    oldest_item_id: items[0]!.id,
    newest_item_id: items.at(-1)!.id,
    is_partial: false,
  })
}

const threadById = (id: string) =>
  useSessionStore.getState().snapshot?.threads.find((thread) => thread.id === id)

describe('demo rpc', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useSessionStore.getState().reset()
    seedDemoWorkspace()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('recognises only the demo session id', () => {
    expect(isDemoSession(DEMO_SESSION_ID)).toBe(true)
    expect(isDemoSession('session-1')).toBe(false)
    expect(isDemoSession(null)).toBe(false)
  })

  it('answers a sent message with a canned reply', async () => {
    const before = useSessionStore.getState().threadItems[THREAD_ID]!.length

    await handleDemoRpc('turn.start', { thread_id: THREAD_ID, inputs: [] })
    expect(threadById(THREAD_ID)?.status).toBe('running')

    await vi.advanceTimersByTimeAsync(2_000)

    const items = useSessionStore.getState().threadItems[THREAD_ID]!
    expect(items).toHaveLength(before + 1)
    expect(items.at(-1)).toMatchObject({
      kind: 'assistant_message',
      text: expect.stringContaining('demo workspace'),
    })
    expect(threadById(THREAD_ID)?.status).toBe('idle')
  })

  it('stops a pending reply when the turn is interrupted', async () => {
    const before = useSessionStore.getState().threadItems[THREAD_ID]!.length

    await handleDemoRpc('turn.start', { thread_id: THREAD_ID, inputs: [] })
    await handleDemoRpc('turn.interrupt', { thread_id: THREAD_ID })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(useSessionStore.getState().threadItems[THREAD_ID]).toHaveLength(before)
    expect(threadById(THREAD_ID)?.status).toBe('idle')
  })

  it('cancels a pending reply when the demo session disconnects', async () => {
    await handleDemoRpc('turn.start', { thread_id: THREAD_ID, inputs: [] })
    useRelayStore.setState({ sessionId: DEMO_SESSION_ID })

    await useRelayStore.getState().disconnect()

    await vi.advanceTimersByTimeAsync(2_000)
    expect(useSessionStore.getState().snapshot).toBeNull()
  })

  it('creates a thread in the demo workspace', async () => {
    const handle = await handleDemoRpc<{
      workspace: { id: string }
      thread: { id: string; workspace_id: string }
    }>('thread.start', { workspace_id: 'demo-workspace' })

    expect(handle.workspace.id).toBe('demo-workspace')
    expect(handle.thread.workspace_id).toBe('demo-workspace')
    expect(handle.thread.id).not.toBe(THREAD_ID)
  })

  it('renames and pins a thread locally', async () => {
    await handleDemoRpc('thread.update', { thread_id: THREAD_ID, title: 'Renamed' })
    expect(threadById(THREAD_ID)?.title).toBe('Renamed')

    await handleDemoRpc('thread.update', { thread_id: THREAD_ID, pinned: true })
    expect(threadById(THREAD_ID)?.is_pinned).toBe(true)
  })

  it('merges preference patches into the stored snapshot', async () => {
    const updated = await handleDemoRpc<{
      notifications: Record<string, unknown>
      conversation: Record<string, unknown>
    }>('preferences.update', { notifications: { enabled: false } })

    expect(updated.notifications.enabled).toBe(false)
    // Untouched sections and sibling fields survive the patch.
    expect(updated.notifications.notify_on_error).toBe(true)
    expect(updated.conversation.tool_details_mode).toBe('compact')
  })

  it('reports unsupported calls as needing a paired desktop', async () => {
    await expect(handleDemoRpc('thread.suggestTitle', {})).rejects.toThrow(
      DEMO_UNAVAILABLE_MESSAGE,
    )
    await expect(handleDemoRpc('turn.start', {})).rejects.toThrow(
      DEMO_UNAVAILABLE_MESSAGE,
    )
  })
})
