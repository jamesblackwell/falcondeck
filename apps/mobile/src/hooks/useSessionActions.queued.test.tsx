import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QueuedTurns } from '@/components/chat/QueuedTurns'
import { useRelayStore } from '@/store/relay-store'
import { useSelectedQueuedTurns, useSessionStore } from '@/store/session-store'
import { useUIStore } from '@/store/ui-store'
import { conversationItemAddedEvent, snapshot, snapshotEvent, thread, threadUpdatedEvent, userMessage, workspace } from '@/test/factories'
import { cleanup, renderComponent, textOf } from '@/test/render'
import { useSessionActions } from './useSessionActions'

const noop = async () => {}
type RelayState = ReturnType<typeof useRelayStore.getState>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function mountQueue() {
  let actions!: ReturnType<typeof useSessionActions>
  function Harness() {
    actions = useSessionActions()
    const queuedTurns = useSelectedQueuedTurns()
    return <QueuedTurns queuedTurns={queuedTurns} canSteer onRemove={noop} onSteer={noop} onEdit={noop} />
  }
  const renderer = renderComponent(<Harness />)
  return { renderer, submit: () => actions.submitTurn() }
}

function selectBusyThread(status: 'running' | 'waiting_for_input' = 'running') {
  useSessionStore.getState().applyDaemonEvent(snapshotEvent(snapshot({
    workspaces: [workspace({ id: 'w1', current_thread_id: 't1' })],
    threads: [thread({ id: 't1', workspace_id: 'w1', status })],
  })))
  useSessionStore.getState().selectThread('w1', 't1')
  useUIStore.getState().setDraft('Also update the changelog')
}

function slowSend() {
  const response = deferred<unknown>()
  const started = deferred<Record<string, unknown>>()
  const rpc = vi.fn((_method: string, params: Record<string, unknown>) => {
    started.resolve(params)
    return response.promise
  })
  useRelayStore.setState({ _callRpc: rpc as RelayState['_callRpc'], _setError: vi.fn() })
  return { response, started, rpc }
}

function confirmQueue() {
  const current = useSessionStore.getState().snapshot!.threads.find((entry) => entry.id === 't1')!
  const queued = {
    id: 'queued-daemon', preview: 'Also update the changelog',
    text: 'Also update the changelog', attachment_count: 0,
    queued_at: new Date().toISOString(),
  }
  useSessionStore.getState().applyDaemonEvent(threadUpdatedEvent({
    ...current, queued_turns: [...current.queued_turns, queued], updated_at: new Date().toISOString(),
  }))
}

function rows(renderer: ReturnType<typeof renderComponent>) {
  return renderer.root.findAllByType('Pressable' as never)
    .filter((node) => String(node.props.accessibilityLabel ?? '').startsWith('Queued message:'))
}

beforeEach(() => {
  useSessionStore.getState().reset()
  useUIStore.setState({
    conversationKey: 'none:new', drafts: {}, draft: '',
    attachments: [], attachmentsByConversation: {},
    pendingSubmissions: {}, inFlightSubmissions: {}, isSubmitting: false,
    selectedProvider: null, selectedModel: null,
  })
})
afterEach(cleanup)

describe('instant queued sends', () => {
  it.each(['running', 'waiting_for_input'] as const)('renders the queued message on the %s send tap before the RPC starts', async (status) => {
    selectBusyThread(status)
    const { response, rpc } = slowSend()
    const { renderer, submit } = mountQueue()
    let submission!: Promise<void>
    act(() => { submission = submit() })
    try {
      expect(useUIStore.getState().draft).toBe('')
      expect(rpc).not.toHaveBeenCalled()
      expect(textOf(renderer)).toContain('Also update the changelog')
      expect(useSessionStore.getState().threadItems.t1 ?? []).toEqual([])
      expect(rows(renderer)[0]!.props.disabled).toBe(true)
    } finally {
      response.resolve({ ok: true, message: 'queued' })
      await act(async () => submission)
    }
  })

  it.each(['response-first', 'event-first'])('keeps one row when the queue confirmation is %s', async (order) => {
    selectBusyThread()
    const { response, started } = slowSend()
    const { renderer, submit } = mountQueue()
    let submission!: Promise<void>
    act(() => { submission = submit() })
    await act(async () => { await started.promise })

    // A streaming thread update without the queued row must not erase it.
    act(() => useSessionStore.getState().applyDaemonEvent(threadUpdatedEvent(thread({
      id: 't1', workspace_id: 'w1', status: 'running', updated_at: new Date().toISOString(),
    }))))
    expect(rows(renderer)).toHaveLength(1)

    if (order === 'response-first') {
      response.resolve({ ok: true, message: 'queued' })
      await act(async () => submission)
      expect(rows(renderer)).toHaveLength(1)
      expect(rows(renderer)[0]!.props.disabled).toBe(true)
    }
    act(confirmQueue)
    expect(rows(renderer)).toHaveLength(1)
    expect(rows(renderer)[0]!.props.disabled).toBe(false)
    expect(useSessionStore.getState().pendingQueuedTurns.t1).toBeUndefined()
    if (order === 'event-first') {
      response.resolve({ ok: true, message: 'queued' })
      await act(async () => submission)
    }
    expect(rows(renderer)).toHaveLength(1)
  })

  it('keeps an identical message already in the queue separate from the new send', async () => {
    selectBusyThread()
    const current = useSessionStore.getState().snapshot!.threads[0]!
    useSessionStore.getState().applyThreadSummary({
      ...current,
      queued_turns: [{ id: 'queued-old', preview: 'Also update the changelog', text: 'Also update the changelog', queued_at: current.updated_at }],
    })
    const { response } = slowSend()
    const { renderer, submit } = mountQueue()
    let submission!: Promise<void>
    act(() => { submission = submit() })
    expect(rows(renderer)).toHaveLength(2)
    response.resolve({ ok: true, message: 'queued' })
    await act(async () => submission)
    expect(rows(renderer)).toHaveLength(2)
    act(confirmQueue)
    expect(rows(renderer)).toHaveLength(2)
    expect(rows(renderer).every((row) => !row.props.disabled)).toBe(true)
  })

  it('reconciles identical sends accepted before either queue event arrives one at a time', async () => {
    selectBusyThread()
    const { response } = slowSend()
    const { renderer, submit } = mountQueue()
    let first!: Promise<void>
    act(() => { first = submit() })
    response.resolve({ ok: true, message: 'queued' })
    await act(async () => first)
    act(() => useUIStore.getState().setDraft('Also update the changelog'))
    await act(async () => { await submit() })
    expect(rows(renderer)).toHaveLength(2)

    act(confirmQueue)
    expect(rows(renderer)).toHaveLength(2)
    expect(rows(renderer).map((row) => row.props.disabled)).toEqual([false, true])
    const current = useSessionStore.getState().snapshot!.threads[0]!
    act(() => useSessionStore.getState().applyDaemonEvent(threadUpdatedEvent({
      ...current, updated_at: new Date().toISOString(),
    })))
    expect(rows(renderer)).toHaveLength(2)
    expect(rows(renderer).map((row) => row.props.disabled)).toEqual([false, true])
    act(() => useSessionStore.getState().applyThreadSummary({
      ...current,
      queued_turns: [...current.queued_turns, { ...current.queued_turns[0]!, id: 'queued-second' }],
    }))
    expect(rows(renderer)).toHaveLength(2)
    expect(rows(renderer).every((row) => !row.props.disabled)).toBe(true)
  })

  it('keeps the pending queue scoped to its thread across navigation', async () => {
    selectBusyThread()
    useSessionStore.getState().applyThreadHandle({
      workspace: workspace({ id: 'w1', current_thread_id: 't1' }),
      thread: thread({ id: 't2', workspace_id: 'w1' }),
    })
    const { response } = slowSend()
    const { renderer, submit } = mountQueue()
    let submission!: Promise<void>
    act(() => { submission = submit() })
    expect(rows(renderer)).toHaveLength(1)
    act(() => useSessionStore.getState().selectThread('w1', 't2'))
    expect(rows(renderer)).toHaveLength(0)
    response.resolve({ ok: true, message: 'queued' })
    await act(async () => submission)
    expect(rows(renderer)).toHaveLength(0)
    act(() => useSessionStore.getState().selectThread('w1', 't1'))
    expect(rows(renderer)).toHaveLength(1)
    act(confirmQueue)
    expect(rows(renderer)).toHaveLength(1)
    expect(rows(renderer)[0]!.props.disabled).toBe(false)
  })

  it('restores the draft and attachments when the queued send fails', async () => {
    selectBusyThread()
    const attachment = { type: 'image' as const, id: 'img-1', name: 'image.png', mime_type: 'image/png', url: 'data:image/png;base64,abc' }
    useUIStore.getState().setAttachments([attachment])
    const { response, started } = slowSend()
    const { renderer, submit } = mountQueue()
    let submission!: Promise<void>
    act(() => { submission = submit() })
    expect(textOf(renderer)).toContain('Also update the changelog')
    expect(textOf(renderer)).toContain('1')
    await act(async () => { await started.promise })
    response.reject(new Error('offline'))
    await act(async () => submission)
    expect(rows(renderer)).toHaveLength(0)
    expect(useUIStore.getState().draft).toBe('Also update the changelog')
    expect(useUIStore.getState().attachments).toEqual([attachment])
  })

  it.each([null, 'steered'])('moves the local queue row into the transcript when the daemon returns %s', async (message) => {
    selectBusyThread()
    const { response, started } = slowSend()
    const { renderer, submit } = mountQueue()
    let submission!: Promise<void>
    act(() => { submission = submit() })
    const params = await started.promise
    response.resolve({ ok: true, message })
    await act(async () => submission)
    expect(rows(renderer)).toHaveLength(0)
    expect(useSessionStore.getState().threadItems.t1).toEqual([
      expect.objectContaining({ id: params.user_item_id, text: 'Also update the changelog', pending: true }),
    ])
  })

  it.each(['queued', 'steered'])('preserves a dispatched user echo that arrives before the %s response', async (message) => {
    selectBusyThread()
    const { response, started } = slowSend()
    const { renderer, submit } = mountQueue()
    let submission!: Promise<void>
    act(() => { submission = submit() })
    const params = await started.promise
    const echo = userMessage(params.user_item_id as string, 'Also update the changelog')
    act(() => useSessionStore.getState().applyDaemonEvent(conversationItemAddedEvent(echo, 't1')))
    expect(rows(renderer)).toHaveLength(0)
    response.resolve({ ok: true, message })
    await act(async () => submission)
    expect(rows(renderer)).toHaveLength(0)
    expect(useSessionStore.getState().threadItems.t1).toEqual([echo])
  })

  it('adds the queue row when the thread became busy after the send tap', async () => {
    selectBusyThread()
    useSessionStore.getState().applyThreadSummary(thread({ id: 't1', workspace_id: 'w1', status: 'idle' }))
    const { response } = slowSend()
    const { renderer, submit } = mountQueue()
    let submission!: Promise<void>
    act(() => { submission = submit() })
    expect(rows(renderer)).toHaveLength(0)
    response.resolve({ ok: true, message: 'queued' })
    await act(async () => submission)
    expect(rows(renderer)).toHaveLength(1)
    expect(useSessionStore.getState().threadItems.t1).toEqual([])
    act(confirmQueue)
    expect(rows(renderer)).toHaveLength(1)
    expect(rows(renderer)[0]!.props.disabled).toBe(false)
  })
})
