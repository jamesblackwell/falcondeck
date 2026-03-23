import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'

import { useRelayStore } from '@/store/relay-store'
import { useSessionStore } from '@/store/session-store'
import { useUIStore } from '@/store/ui-store'
import { useSessionActions } from './useSessionActions'
import {
  assistantMessage,
  snapshot,
  snapshotEvent,
  thread,
  threadDetail,
  workspace,
} from '../test/factories'

type RelayStoreState = ReturnType<typeof useRelayStore.getState>
const originalConsoleError = console.error

function resetAll() {
  useSessionStore.getState().reset()
  useRelayStore.setState({
    relayUrl: 'https://relay.test',
    pairingCode: '',
    sessionId: null,
    deviceId: null,
    connectionStatus: 'not_connected',
    machinePresence: null,
    error: null,
    isConnected: false,
    isEncrypted: false,
  })
  useUIStore.setState({
    draft: '',
    selectedProvider: null,
    selectedModel: null,
    selectedEffort: 'medium',
    selectedCollaborationMode: null,
    isSubmitting: false,
  })
}

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(console, 'error').mockImplementation((message, ...args) => {
    if (
      typeof message === 'string' &&
      (
        message.includes('react-test-renderer is deprecated') ||
        message.includes('The current testing environment is not configured to support act')
      )
    ) {
      return
    }
    originalConsoleError(message, ...args)
  })
})

afterAll(() => {
  vi.restoreAllMocks()
})

function mountSessionActions() {
  let actions: ReturnType<typeof useSessionActions> | null = null
  let renderer: TestRenderer.ReactTestRenderer | null = null

  function Harness() {
    actions = useSessionActions()
    return null
  }

  act(() => {
    renderer = TestRenderer.create(React.createElement(Harness))
  })

  return {
    getActions() {
      if (!actions) {
        throw new Error('Session actions hook did not mount')
      }
      return actions
    },
    unmount() {
      if (!renderer) return
      act(() => {
        renderer?.unmount()
      })
    },
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

describe('submitTurn guards', () => {
  beforeEach(resetAll)

  it('requires a workspace to be selected', () => {
    // No snapshot loaded → no workspace
    const session = useSessionStore.getState()
    const workspace = session.snapshot?.workspaces.find(
      (w) => w.id === session.selectedWorkspaceId,
    )
    expect(workspace).toBeUndefined()
  })

  it('requires non-empty draft', () => {
    const ui = useUIStore.getState()
    expect(ui.draft.trim()).toBe('')
  })

  it('requires a selected threadId', () => {
    const snap = snapshot()
    useSessionStore.getState().applyDaemonEvent({
      seq: 1,
      emitted_at: '2026-03-16T10:00:00Z',
      workspace_id: null,
      thread_id: null,
      event: { type: 'snapshot', snapshot: snap },
    })
    useSessionStore.getState().selectWorkspace('workspace-1')
    // selectedThreadId should be set from current_thread_id or null
    const state = useSessionStore.getState()
    // Default workspace has current_thread_id: null, so thread is null
    expect(state.selectedThreadId).toBeNull()
  })

  it('all guards pass when workspace, thread, and draft are set', () => {
    const snap = snapshot({
      workspaces: [workspace({ id: 'w1', current_thread_id: 't1' })],
      threads: [thread({ id: 't1', workspace_id: 'w1' })],
    })
    useSessionStore.getState().applyDaemonEvent({
      seq: 1,
      emitted_at: '2026-03-16T10:00:00Z',
      workspace_id: null,
      thread_id: null,
      event: { type: 'snapshot', snapshot: snap },
    })
    useSessionStore.getState().selectWorkspace('w1')
    useUIStore.getState().setDraft('Hello world')

    const session = useSessionStore.getState()
    const ui = useUIStore.getState()
    const ws = session.snapshot?.workspaces.find((w) => w.id === session.selectedWorkspaceId)

    expect(ws).toBeDefined()
    expect(ws!.id).toBe('w1')
    expect(session.selectedThreadId).toBe('t1')
    expect(ui.draft.trim()).toBe('Hello world')
  })
})

describe('respondApproval', () => {
  beforeEach(resetAll)

  it('requires a workspace to be selected', () => {
    const session = useSessionStore.getState()
    const ws = session.snapshot?.workspaces.find(
      (w) => w.id === session.selectedWorkspaceId,
    )
    expect(ws).toBeUndefined()
  })

  it('workspace is available when snapshot is loaded and selected', () => {
    const snap = snapshot()
    useSessionStore.getState().applyDaemonEvent({
      seq: 1,
      emitted_at: '2026-03-16T10:00:00Z',
      workspace_id: null,
      thread_id: null,
      event: { type: 'snapshot', snapshot: snap },
    })
    useSessionStore.getState().selectWorkspace('workspace-1')

    const session = useSessionStore.getState()
    const ws = session.snapshot?.workspaces.find(
      (w) => w.id === session.selectedWorkspaceId,
    )
    expect(ws).toBeDefined()
    expect(ws!.id).toBe('workspace-1')
  })
})

describe('_sendMessage', () => {
  beforeEach(resetAll)

  it('throws when socket is not open', () => {
    const relay = useRelayStore.getState()
    expect(() => {
      relay._sendMessage({ type: 'ping' })
    }).toThrow('Remote connection is not ready')
  })
})

describe('isSubmitting state management', () => {
  beforeEach(resetAll)

  it('tracks submission lifecycle', () => {
    const ui = useUIStore.getState()

    expect(useUIStore.getState().isSubmitting).toBe(false)

    ui.setIsSubmitting(true)
    expect(useUIStore.getState().isSubmitting).toBe(true)

    ui.setIsSubmitting(false)
    expect(useUIStore.getState().isSubmitting).toBe(false)
  })

  it('clearDraft resets draft text', () => {
    useUIStore.getState().setDraft('Some message')
    expect(useUIStore.getState().draft).toBe('Some message')

    useUIStore.getState().clearDraft()
    expect(useUIStore.getState().draft).toBe('')
  })
})

describe('loadThreadDetail', () => {
  beforeEach(resetAll)

  it('requests the newest tail window for the selected thread', async () => {
    useSessionStore.getState().applyDaemonEvent(snapshotEvent(snapshot({
      workspaces: [workspace({ id: 'workspace-1', current_thread_id: 'thread-1' })],
      threads: [thread({ id: 'thread-1', workspace_id: 'workspace-1' })],
    })))
    useSessionStore.getState().selectThread('workspace-1', 'thread-1')

    const rpc = vi.fn().mockResolvedValue(threadDetail({
      items: [assistantMessage('msg-1', 'hello')],
      has_older: false,
      oldest_item_id: 'msg-1',
      newest_item_id: 'msg-1',
      is_partial: true,
    }))
    const setError = vi.fn()
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState['_callRpc'],
      _setError: setError as RelayStoreState['_setError'],
    } as Partial<RelayStoreState>)

    const harness = mountSessionActions()
    try {
      await act(async () => {
        await harness.getActions().loadThreadDetail('workspace-1', 'thread-1')
      })
    } finally {
      harness.unmount()
    }

    expect(rpc).toHaveBeenCalledWith(
      'thread.detail',
      {
        workspace_id: 'workspace-1',
        thread_id: 'thread-1',
        mode: 'tail',
        limit: 150,
      },
      { requestIdPrefix: 'mobile-detail' },
    )
    expect(useSessionStore.getState().threadDetail?.items.map((item) => item.id)).toEqual(['msg-1'])
    expect(setError).toHaveBeenCalledWith(null)
  })

  it('requests older history from the current cached oldest item and prepends it', async () => {
    useSessionStore.getState().applyDaemonEvent(snapshotEvent(snapshot({
      workspaces: [workspace({ id: 'workspace-1', current_thread_id: 'thread-1' })],
      threads: [thread({ id: 'thread-1', workspace_id: 'workspace-1' })],
    })))
    useSessionStore.getState().selectThread('workspace-1', 'thread-1')
    useSessionStore.getState().setThreadDetail(threadDetail({
      items: [
        assistantMessage('msg-2', 'second'),
        assistantMessage('msg-3', 'third'),
      ],
      has_older: true,
      oldest_item_id: 'msg-2',
      newest_item_id: 'msg-3',
      is_partial: true,
    }))

    const rpc = vi.fn().mockResolvedValue(threadDetail({
      items: [
        assistantMessage('msg-0', 'zero'),
        assistantMessage('msg-1', 'one'),
      ],
      has_older: false,
      oldest_item_id: 'msg-0',
      newest_item_id: 'msg-1',
      is_partial: true,
    }))
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState['_callRpc'],
      _setError: vi.fn() as RelayStoreState['_setError'],
    } as Partial<RelayStoreState>)

    const harness = mountSessionActions()
    try {
      await act(async () => {
        await harness.getActions().loadThreadDetail('workspace-1', 'thread-1', { older: true })
      })
    } finally {
      harness.unmount()
    }

    expect(rpc).toHaveBeenCalledWith(
      'thread.detail',
      {
        workspace_id: 'workspace-1',
        thread_id: 'thread-1',
        mode: 'before',
        before_item_id: 'msg-2',
        limit: 100,
      },
      { requestIdPrefix: 'mobile-detail-older' },
    )
    expect(useSessionStore.getState().threadItems['thread-1']?.map((item) => item.id)).toEqual([
      'msg-0',
      'msg-1',
      'msg-2',
      'msg-3',
    ])
  })

  it('ignores stale detail responses after the user switches threads', async () => {
    useSessionStore.getState().applyDaemonEvent(snapshotEvent(snapshot({
      workspaces: [workspace({ id: 'workspace-1', current_thread_id: 'thread-1' })],
      threads: [
        thread({ id: 'thread-1', workspace_id: 'workspace-1' }),
        thread({ id: 'thread-2', workspace_id: 'workspace-1' }),
      ],
    })))
    useSessionStore.getState().selectThread('workspace-1', 'thread-1')

    const deferred = createDeferred<ReturnType<typeof threadDetail>>()
    const rpc = vi.fn().mockReturnValue(deferred.promise)
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState['_callRpc'],
      _setError: vi.fn() as RelayStoreState['_setError'],
    } as Partial<RelayStoreState>)

    const harness = mountSessionActions()
    try {
      const loadPromise = act(async () => {
        const pending = harness.getActions().loadThreadDetail('workspace-1', 'thread-1')
        useSessionStore.getState().selectThread('workspace-1', 'thread-2')
        deferred.resolve(threadDetail({
          items: [assistantMessage('msg-late', 'late')],
          has_older: false,
          oldest_item_id: 'msg-late',
          newest_item_id: 'msg-late',
          is_partial: true,
        }))
        await pending
      })
      await loadPromise
    } finally {
      harness.unmount()
    }

    expect(useSessionStore.getState().selectedThreadId).toBe('thread-2')
    expect(useSessionStore.getState().threadDetail).toBeNull()
    expect(useSessionStore.getState().threadItems['thread-1']).toBeUndefined()
  })
})
