import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as clientCore from '@falcondeck/client-core'

import { useConversationPresentation } from '@/hooks/useRenderBlocks'
import { cleanup, renderComponent } from '@/test/render'
import { assistantMessage, snapshot, thread, userMessage } from '@/test/factories'

import {
  useConversationItems,
  useSelectedQueuedTurns,
  useSelectedThread,
  useSelectedThreadHistory,
  useSessionStore,
} from './session-store'
import { useUIStore } from './ui-store'

beforeEach(() => {
  vi.useFakeTimers()
  useSessionStore.getState().reset()
  useUIStore.setState({ pendingNewThreadItem: null })
})

afterEach(() => {
  cleanup()
  useSessionStore.getState().reset()
  useUIStore.setState({ pendingNewThreadItem: null })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('selected transcript subscriptions', () => {
  it('keeps an unresolved new-thread prompt stable through unrelated composer renders', () => {
    useSessionStore.setState({
      snapshot: snapshot(),
      selectedWorkspaceId: 'workspace-1',
      selectedThreadId: null,
    })
    const pending = { ...userMessage('pending', 'x'.repeat(256 * 1024)), pending: true }
    useUIStore.getState().setPendingNewThreadItem({
      conversationKey: useUIStore.getState().conversationKey,
      item: pending,
    })
    const derive = vi.spyOn(clientCore, 'deriveConversationPresentation')
    let items: ReturnType<typeof useConversationItems> = []
    function Harness() {
      useUIStore(state => state.draft)
      useUIStore(state => state.isSubmitting)
      items = useConversationItems()
      useConversationPresentation()
      return null
    }
    renderComponent(<Harness />)
    const originalItems = items
    expect(items).toEqual([pending])

    for (let index = 0; index < 20; index += 1) {
      act(() => useUIStore.setState({ draft: `Draft ${index}`, isSubmitting: index % 2 === 0 }))
    }
    expect(derive).toHaveBeenCalledTimes(1)
    expect(items).toBe(originalItems)
  })

  it('updates optimistic replacements and clears while keeping loaded history ahead of the fallback', () => {
    useSessionStore.setState({
      snapshot: snapshot(),
      selectedWorkspaceId: 'workspace-1',
      selectedThreadId: null,
    })
    const conversationKey = useUIStore.getState().conversationKey
    const first = userMessage('pending', 'First prompt')
    useUIStore.getState().setPendingNewThreadItem({ conversationKey, item: first })
    let items: ReturnType<typeof useConversationItems> = []
    function Harness({ pause = false }: { pause?: boolean }) {
      items = useConversationItems({ pause })
      return null
    }
    const renderer = renderComponent(<Harness />)
    const originalItems = items
    act(() => renderer.update(<Harness pause />))
    expect(items).toBe(originalItems)

    const replacement = userMessage('pending', 'Replacement prompt')
    act(() => useUIStore.getState().setPendingNewThreadItem({ conversationKey, item: replacement }))
    expect(items).toEqual([replacement])
    expect(items).not.toBe(originalItems)
    act(() => useUIStore.getState().setPendingNewThreadItem(null))
    expect(items).toEqual([])

    const loaded = [assistantMessage('history', 'Loaded history')]
    act(() => renderer.update(<Harness />))
    act(() => useSessionStore.setState({
      selectedThreadId: 'thread-1',
      threadItems: { 'thread-1': loaded },
    }))
    act(() => useUIStore.getState().setPendingNewThreadItem({
      conversationKey: useUIStore.getState().conversationKey,
      item: replacement,
    }))
    expect(items).toBe(loaded)

    act(() => useSessionStore.setState({ selectedThreadId: null }))
    expect(items).toEqual([])
  })

  it('shares one catalog lookup across the screen hooks and unrelated store updates', () => {
    let catalogReads = 0
    const threads = new Proxy(
      Array.from({ length: 3_000 }, (_, index) => thread({ id: `thread-${index}` })),
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) catalogReads += 1
          return Reflect.get(target, property, receiver)
        },
      },
    )
    useSessionStore.setState({
      snapshot: snapshot({ threads }),
      selectedWorkspaceId: 'workspace-1',
      selectedThreadId: 'thread-2999',
      threadItems: { 'thread-2999': [assistantMessage('reply', 'Cached reply')] },
    })

    let renders = 0
    function Harness() {
      useSelectedThread()
      useSelectedQueuedTurns()
      useSelectedThreadHistory()
      useConversationItems()
      useConversationPresentation()
      renders += 1
      return null
    }
    renderComponent(<Harness />)
    expect(catalogReads).toBe(3_000)

    const mountedRenders = renders
    catalogReads = 0
    for (let index = 0; index < 20; index += 1) {
      act(() => useSessionStore.getState().setThreadDetailError('background', `error-${index}`))
    }
    expect(catalogReads).toBe(0)
    expect(renders).toBe(mountedRenders)
  })

  it('invalidates on selection, workspace boundary and replaced summaries', () => {
    const a = thread({ id: 'same-id', workspace_id: 'a', status: 'idle' })
    const b = thread({ id: 'same-id', workspace_id: 'b', status: 'running' })
    useSessionStore.setState({
      snapshot: snapshot({ threads: [a, b] }),
      selectedWorkspaceId: 'a',
      selectedThreadId: 'same-id',
    })

    let selected: ReturnType<typeof useSelectedThread> = null
    let items: ReturnType<typeof useConversationItems> = []
    function Harness() {
      selected = useSelectedThread()
      items = useConversationItems()
      return null
    }
    renderComponent(<Harness />)
    expect(selected).toBe(a)

    act(() => useSessionStore.setState({ selectedWorkspaceId: 'b' }))
    expect(selected).toBe(b)
    const replacement = { ...b, status: 'idle' as const }
    act(() => useSessionStore.setState({ snapshot: snapshot({ threads: [a, replacement] }) }))
    expect(selected).toBe(replacement)

    act(() => useSessionStore.setState({ selectedWorkspaceId: 'missing' }))
    expect(selected).toBeNull()
    expect(items).toEqual([])
    act(() => useSessionStore.setState({ selectedWorkspaceId: 'a', selectedThreadId: null }))
    expect(selected).toBeNull()
  })

  it('skips hidden transcript lookups and catches up to live items and status when resumed', () => {
    useSessionStore.setState({
      snapshot: snapshot({ threads: [thread({ status: 'running' })] }),
      selectedWorkspaceId: 'workspace-1',
      selectedThreadId: 'thread-1',
      threadItems: { 'thread-1': [assistantMessage('reply', 'First')] },
    })

    let items: ReturnType<typeof useConversationItems> = []
    let blocks: ReturnType<typeof useConversationPresentation>['history_blocks'] = []
    function Harness({ pause }: { pause: boolean }) {
      items = useConversationItems({ pause })
      blocks = useConversationPresentation({ pause }).history_blocks
      useSelectedThreadHistory({ pause })
      return null
    }
    const renderer = renderComponent(<Harness pause={false} />)
    const originalItems = items
    const originalBlocks = blocks
    act(() => renderer.update(<Harness pause />))

    let catalogReads = 0
    const threads = new Proxy([thread({ status: 'idle' })], {
      get(target, property, receiver) {
        if (property === '0') catalogReads += 1
        return Reflect.get(target, property, receiver)
      },
    })
    act(() => useSessionStore.setState({
      snapshot: snapshot({ threads }),
      threadItems: { 'thread-1': [assistantMessage('reply', 'Latest')] },
    }))
    expect(catalogReads).toBe(0)
    expect(items).toBe(originalItems)
    expect(blocks).toBe(originalBlocks)

    act(() => renderer.update(<Harness pause={false} />))
    expect(catalogReads).toBe(1)
    expect(items[0]).toMatchObject({ text: 'Latest' })
    expect(blocks).not.toBe(originalBlocks)
  })
})
