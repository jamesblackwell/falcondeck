import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useRelayStore } from '@/store/relay-store'
import { useSessionStore } from '@/store/session-store'
import { snapshot, thread, workspace } from '@/test/factories'
import { openThreadLink } from './thread-link'

const originalRpc = useRelayStore.getState()._callRpc
let rpc: ReturnType<typeof vi.fn>

function deferredSnapshot() {
  let resolve!: (value: ReturnType<typeof snapshot>) => void
  let reject!: (error: Error) => void
  const promise = new Promise<ReturnType<typeof snapshot>>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

beforeEach(() => {
  useSessionStore.getState().reset()
  useSessionStore.setState({ snapshot: snapshot(), selectedThreadId: 'thread-1', selectedWorkspaceId: 'workspace-1' })
  rpc = vi.fn()
  useRelayStore.setState({ sessionId: 'source-session', _callRpc: rpc })
})

afterEach(() => {
  useSessionStore.getState().reset()
  useRelayStore.setState({ sessionId: null, _callRpc: originalRpc })
})

describe('opening task links', () => {
  it('selects a cached renamed task without making a request', async () => {
    const target = thread({ id: 'linked', title: 'Renamed task' })
    useSessionStore.setState({ snapshot: snapshot({ threads: [target] }) })
    expect(await openThreadLink('linked')).toBe(true)
    expect(useSessionStore.getState().selectedThreadId).toBe('linked')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('resolves an uncached destination across projects without replacing the live index', async () => {
    const project = workspace({ id: 'other-project' })
    const target = thread({ id: 'older-task', workspace_id: project.id })
    rpc.mockResolvedValue(snapshot({ workspaces: [project], threads: [target] }))
    const original = useSessionStore.getState().snapshot!

    expect(await openThreadLink(target.id)).toBe(true)

    const state = useSessionStore.getState()
    expect(state.selectedWorkspaceId).toBe(project.id)
    expect(state.selectedThreadId).toBe(target.id)
    expect(state.snapshot!.threads).toContainEqual(original.threads[0])
    expect(state.snapshot!.workspaces[0]).toBe(original.workspaces[0])
    expect(state.snapshot!.preferences).toBe(original.preferences)
    expect(rpc).toHaveBeenCalledWith('snapshot.current', expect.objectContaining({
      include_archived_threads: true, include_thread_plans: false, include_thread_diffs: false,
    }), expect.anything())
  })

  it('reports a genuinely missing task without changing the selection', async () => {
    rpc.mockResolvedValue(snapshot())
    await expect(openThreadLink('missing')).rejects.toThrow('no longer available')
    expect(useSessionStore.getState().selectedThreadId).toBe('thread-1')
  })

  it.each([true, false])('keeps archived tasks closed (cached: %s)', async cached => {
    const archived = thread({ id: 'archived-task', is_archived: true })
    if (cached) useSessionStore.setState({ snapshot: snapshot({ threads: [archived] }) })
    else rpc.mockResolvedValue(snapshot({ threads: [archived] }))
    await expect(openThreadLink(archived.id)).rejects.toThrow('archived')
    expect(useSessionStore.getState().selectedThreadId).toBe('thread-1')
  })

  it('ignores a lookup after the paired computer changes', async () => {
    const pending = deferredSnapshot()
    rpc.mockReturnValue(pending.promise)
    const opening = openThreadLink('older-task')
    useRelayStore.setState({ sessionId: 'another-session' })
    pending.resolve(snapshot({ threads: [thread({ id: 'older-task' })] }))
    expect(await opening).toBe(false)
    expect(useSessionStore.getState().selectedThreadId).toBe('thread-1')
  })

  it('does not override a later sidebar selection, even after navigating back', async () => {
    const pending = deferredSnapshot()
    rpc.mockReturnValue(pending.promise)
    const opening = openThreadLink('older-task')
    useSessionStore.getState().selectNewThread('workspace-1')
    useSessionStore.getState().selectThread('workspace-1', 'thread-1')
    pending.resolve(snapshot({ threads: [thread({ id: 'older-task' })] }))
    expect(await opening).toBe(false)
    expect(useSessionStore.getState().selectedThreadId).toBe('thread-1')
  })

  it('lets a newer link supersede an earlier lookup', async () => {
    const first = deferredSnapshot(), second = deferredSnapshot()
    rpc.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const firstOpening = openThreadLink('first')
    const secondOpening = openThreadLink('second')
    first.resolve(snapshot({ threads: [thread({ id: 'first' })] }))
    expect(await firstOpening).toBe(false)
    second.resolve(snapshot({ threads: [thread({ id: 'second' })] }))
    expect(await secondOpening).toBe(true)
    expect(useSessionStore.getState().selectedThreadId).toBe('second')
  })

  it('ignores stale failures and lets an active failure be retried', async () => {
    const pending = deferredSnapshot()
    rpc.mockReturnValueOnce(pending.promise)
    const opening = openThreadLink('older-task')
    useSessionStore.getState().selectNewThread('workspace-1')
    pending.reject(new Error('Disconnected'))
    expect(await opening).toBe(false)
    rpc.mockRejectedValueOnce(new Error('Disconnected'))
    await expect(openThreadLink('older-task')).rejects.toThrow('Check your connection')
    rpc.mockResolvedValueOnce(snapshot({ threads: [thread({ id: 'older-task' })] }))
    expect(await openThreadLink('older-task')).toBe(true)
  })
})
