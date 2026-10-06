import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appStateListeners = vi.hoisted(() => new Set<(status: string) => void>())
vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>()
  return { ...actual, AppState: { ...actual.AppState, addEventListener: (_event: string, listener: (status: string) => void) => {
    appStateListeners.add(listener)
    return { remove: () => appStateListeners.delete(listener) }
  } } }
})

import { storage } from '@/storage/mmkv'
import { decryptSessionValue, setSessionStorageEncryptionKey } from '@/storage/session-encrypted-storage'
import { useRelayStore } from '@/store/relay-store'
import { useSessionStore } from '@/store/session-store'
import { clearEncryptedComposerPersistence, useUIStore } from '@/store/ui-store'
import { snapshot, snapshotEvent, thread, workspace } from '@/test/factories'
import { cleanup, renderComponent } from '@/test/render'
import { useSessionActions } from './useSessionActions'

const DRAFTS = 'falcondeck.mobile.composer-drafts.v1'
const IN_FLIGHT = 'falcondeck.mobile.composer-in-flight.v1'
type RelayState = ReturnType<typeof useRelayStore.getState>
const originalCryptoGetter = useRelayStore.getState()._getSessionCrypto
let frames: FrameRequestCallback[] = []

function stored(key: string) {
  const raw = storage.getString(key)
  return raw ? decryptSessionValue(JSON.parse(raw)) as Record<string, { text: string }> : {}
}

function mountSend() {
  let submit!: ReturnType<typeof useSessionActions>['submitTurn']
  function Harness() { submit = useSessionActions().submitTurn; return null }
  renderComponent(<Harness />)
  return () => submit()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { resolve, reject, promise }
}

async function paint() {
  const frame = frames.shift()
  expect(frame).toBeDefined()
  await act(async () => {
    frame!(0)
    await vi.advanceTimersByTimeAsync(0)
  })
}

function selectThread(status: 'idle' | 'running' = 'idle') {
  useSessionStore.getState().applyDaemonEvent(snapshotEvent(snapshot({
    workspaces: [workspace({ id: 'w1', current_thread_id: 't1' }), workspace({ id: 'w2' })],
    threads: [thread({ id: 't1', workspace_id: 'w1', status })],
  })))
  useSessionStore.getState().selectThread('w1', 't1')
}

beforeEach(() => {
  vi.useFakeTimers()
  clearEncryptedComposerPersistence()
  setSessionStorageEncryptionKey(new Uint8Array(32).fill(11))
  useSessionStore.getState().reset()
  useUIStore.setState({
    conversationKey: 'none:new', drafts: {}, draft: '', attachments: [], attachmentsByConversation: {},
    inFlightSubmissions: {}, pendingSubmissions: {}, pendingNewThreadItem: null, isSubmitting: false,
    selectedProvider: null, selectedModel: null, selectedPermissionMode: null, selectedSandboxMode: null, selectedIsolation: 'project_folder',
  })
  useRelayStore.setState({ sessionId: null, _getSessionCrypto: originalCryptoGetter, _callRpc: vi.fn().mockResolvedValue({ ok: true }) as RelayState['_callRpc'], _setError: vi.fn() })
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
})
afterEach(() => {
  cleanup()
  clearEncryptedComposerPersistence()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('send feedback before recovery encryption', () => {
  it.each(['idle', 'running'] as const)('publishes %s feedback before any composer persistence with 100 large drafts', async (status) => {
    selectThread(status)
    const drafts = Object.fromEntries(Array.from({ length: 99 }, (_, index) => [`w1:other-${index}`, { text: 'x'.repeat(9000), updatedAt: index }]))
    useUIStore.setState({ drafts })
    useUIStore.getState().setDraft('Leading prefix')
    useUIStore.getState().setDraft('Submitted latest text')
    const writes = vi.spyOn(storage, 'set')
    const response = deferred<unknown>()
    const rpc = vi.fn().mockReturnValue(response.promise)
    useRelayStore.setState({ _callRpc: rpc as RelayState['_callRpc'] })
    const send = mountSend()
    let submission!: Promise<void>
    act(() => { submission = send() })
    expect(useUIStore.getState().draft).toBe('')
    expect(writes.mock.calls.filter(([key]) => key === DRAFTS || key === IN_FLIGHT).map(([key]) => key)).toEqual([])
    expect(rpc).not.toHaveBeenCalled()
    if (status === 'idle') expect(useSessionStore.getState().threadItems.t1?.[0]).toMatchObject({ text: 'Submitted latest text', pending: true })
    else expect(useSessionStore.getState().pendingQueuedTurns.t1?.[0]?.turn).toMatchObject({ text: 'Submitted latest text' })

    await paint()
    expect(writes.mock.calls.filter(([key]) => key === DRAFTS || key === IN_FLIGHT).map(([key]) => key)).toEqual([IN_FLIGHT, DRAFTS])
    expect(stored(IN_FLIGHT)['w1:t1']?.text).toBe('Submitted latest text')
    expect(stored(DRAFTS)['w1:t1']).toBeUndefined()
    expect(rpc).toHaveBeenCalledTimes(1)
    response.resolve({ ok: true })
    await act(async () => submission)
  })

  it('preserves typing during the frame yield and persists it before dispatch', async () => {
    selectThread()
    useUIStore.getState().setDraft('First')
    useUIStore.getState().setDraft('Sent text')
    const response = deferred<unknown>()
    const rpc = vi.fn().mockImplementation(() => {
      expect(stored(IN_FLIGHT)['w1:t1']?.text).toBe('Sent text')
      expect(stored(DRAFTS)['w1:t1']?.text).toBe('New typing')
      return response.promise
    })
    useRelayStore.setState({ _callRpc: rpc as RelayState['_callRpc'] })
    const send = mountSend()
    let submission!: Promise<void>
    act(() => { submission = send() })
    act(() => useUIStore.getState().setDraft('New typing'))
    await paint()
    response.resolve({ ok: true })
    await act(async () => submission)
    expect(useUIStore.getState().draft).toBe('New typing')
  })

  it('starts the original workspace and picker selection after navigation in the frame yield', async () => {
    selectThread()
    useSessionStore.getState().selectNewThread('w1')
    useUIStore.getState().setSelectedProvider('claude')
    useUIStore.getState().setSelectedIsolation('isolated')
    useUIStore.getState().setDraft('New task')
    const rpc = vi.fn().mockResolvedValueOnce({ workspace: workspace({ id: 'w1' }), thread: thread({ id: 'new-thread', workspace_id: 'w1' }) }).mockResolvedValueOnce({ ok: true })
    useRelayStore.setState({ _callRpc: rpc as RelayState['_callRpc'] })
    const send = mountSend()
    let submission!: Promise<void>
    act(() => { submission = send() })
    expect(rpc).not.toHaveBeenCalled()
    act(() => {
      useSessionStore.getState().selectNewThread('w2')
      useUIStore.getState().setSelectedProvider('codex')
      useUIStore.getState().setDraft('Keep this other draft')
    })
    await paint()
    expect(rpc).toHaveBeenNthCalledWith(1, 'thread.start', expect.objectContaining({ workspace_id: 'w1', provider: 'claude', isolation: 'isolated' }), expect.anything())
    expect(useSessionStore.getState().selectedWorkspaceId).toBe('w2')
    await paint()
    await act(async () => submission)
    expect(useUIStore.getState().draft).toBe('Keep this other draft')
  })

  it('flushes staged recovery on background before the frame callback can run', async () => {
    selectThread()
    useUIStore.getState().setDraft('Sent text')
    const send = mountSend()
    let submission!: Promise<void>
    act(() => { submission = send() })
    expect(stored(IN_FLIGHT)['w1:t1']).toBeUndefined()
    appStateListeners.forEach((listener) => listener('background'))
    expect(stored(IN_FLIGHT)['w1:t1']?.text).toBe('Sent text')
    expect(stored(DRAFTS)['w1:t1']).toBeUndefined()
    await paint()
    await act(async () => submission)
  })

  it('cancels a cleared composer checkpoint instead of recreating data or dispatching', async () => {
    selectThread()
    useUIStore.getState().setDraft('Old secret')
    const rpc = vi.fn().mockResolvedValue({ ok: true })
    useRelayStore.setState({ _callRpc: rpc as RelayState['_callRpc'] })
    const send = mountSend()
    let submission!: Promise<void>
    act(() => { submission = send() })
    act(() => clearEncryptedComposerPersistence())
    await paint()
    await act(async () => submission)
    expect(rpc).not.toHaveBeenCalled()
    expect(storage.getString(IN_FLIGHT)).toBeUndefined()
    expect(storage.getString(DRAFTS)).toBeUndefined()
    expect(useUIStore.getState().draft).toBe('')
  })

  it('does not dispatch a captured send onto a replacement relay session', async () => {
    selectThread()
    useUIStore.getState().setDraft('Old session text')
    const rpc = vi.fn().mockResolvedValue({ ok: true })
    useRelayStore.setState({ _callRpc: rpc as RelayState['_callRpc'] })
    const send = mountSend()
    let submission!: Promise<void>
    act(() => { submission = send() })
    useRelayStore.setState({ sessionId: 'replacement' })
    clearEncryptedComposerPersistence()
    await paint()
    await act(async () => submission)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('restores an unsent message and removes its optimistic row when the same session rotates crypto', async () => {
    selectThread()
    useUIStore.getState().setDraft('Keep my message')
    const rpc = vi.fn().mockResolvedValue({ ok: true })
    useRelayStore.setState({ _callRpc: rpc as RelayState['_callRpc'] })
    const send = mountSend()
    let submission!: Promise<void>
    act(() => { submission = send() })
    setSessionStorageEncryptionKey(new Uint8Array(32).fill(17))
    const replacementCrypto = { dataKey: new Uint8Array(32).fill(17) }
    useRelayStore.setState({ _getSessionCrypto: (() => replacementCrypto) as RelayState['_getSessionCrypto'] })
    await paint()
    await act(async () => submission)
    expect(rpc).not.toHaveBeenCalled()
    expect(useSessionStore.getState().threadItems.t1 ?? []).toEqual([])
    expect(useUIStore.getState().draft).toBe('Keep my message')
    expect(stored(DRAFTS)['w1:t1']?.text).toBe('Keep my message')
    expect(stored(IN_FLIGHT)['w1:t1']).toBeUndefined()
  })

  it('does not clear a newer new-thread submission when an earlier relocated send settles', async () => {
    selectThread()
    useSessionStore.getState().selectNewThread('w1')
    useUIStore.getState().setDraft('First new thread')
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    let starts = 0
    const rpc = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === 'thread.start') return Promise.resolve({ workspace: workspace({ id: 'w1' }), thread: thread({ id: `new-${++starts}`, workspace_id: 'w1' }) })
      return params.thread_id === 'new-1' ? first.promise : second.promise
    })
    useRelayStore.setState({ _callRpc: rpc as RelayState['_callRpc'] })
    const send = mountSend()
    let firstSubmission!: Promise<void>
    act(() => { firstSubmission = send() })
    await paint()
    await paint()
    act(() => {
      useSessionStore.getState().selectNewThread('w1')
      useUIStore.getState().setDraft('Second new thread')
    })
    let secondSubmission!: Promise<void>
    act(() => { secondSubmission = send() })
    first.resolve({ ok: true })
    await act(async () => firstSubmission)
    expect(useUIStore.getState().inFlightSubmissions['w1:new']?.text).toBe('Second new thread')
    expect(useUIStore.getState().isSubmitting).toBe(true)
    await paint()
    await paint()
    second.resolve({ ok: true })
    await act(async () => secondSubmission)
  })

})
