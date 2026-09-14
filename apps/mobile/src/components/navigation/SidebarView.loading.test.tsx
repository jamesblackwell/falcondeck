import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, renderComponent, textOf } from '@/test/render'
import { snapshot, workspace } from '@/test/factories'
import { useSessionStore } from '@/store'
import { LOADING_PILL_SHOW_AFTER_MS } from '@/components/ui'
import { SidebarView } from './SidebarView'

const { loadPage, isInFlight } = vi.hoisted(() => ({
  loadPage: vi.fn(),
  isInFlight: vi.fn(() => false),
}))
vi.mock('@/hooks/sync-index', () => ({
  loadSyncThreadPage: loadPage,
  isSyncThreadPageInFlight: () => isInFlight(),
}))
vi.mock('@/hooks/useSessionSyncStatus', () => ({
  useSessionSyncStatus: () => ({ isBusy: false, stage: 'ready' }),
}))
const initialSnapshot = useSessionStore.getState().snapshot

beforeEach(() => {
  vi.useFakeTimers()
  isInFlight.mockReturnValue(false)
})

afterEach(() => {
  cleanup()
  useSessionStore.setState({ snapshot: initialSnapshot })
  vi.clearAllMocks()
  vi.useRealTimers()
})

const pagingIndex = {
  token: 'index-1',
  cursors: {} as Record<string, number | null>,
  touched_threads: {},
  touched_views: {},
  catalog_touched: false,
  extensions_loaded: false,
  counts: {
    'workspace-1': { total: 10, running: 0, unread: 0, awaiting: 0 },
  },
}

it('floats page activity over the list without shifting rows', async () => {
  let finish!: () => void
  loadPage.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  useSessionStore.setState({ snapshot: snapshot({ sync_index: pagingIndex }) })
  const renderer = renderComponent(<SidebarView
    groups={[{ workspace: workspace(), threads: [] }]}
    selectedThreadId={null} onSelectThread={vi.fn()} onNewThread={vi.fn()}
  />)
  expect(loadPage).toHaveBeenCalledWith('workspace-1', 'last_updated', 5)
  expect(textOf(renderer)).toContain('PROJECTS')
  expect(textOf(renderer)).toContain('Show more')
  expect(textOf(renderer)).not.toContain('Loading tasks…')
  expect(
    renderer.root.findByProps({ accessibilityLabel: 'Show more' }).props.accessibilityState?.busy,
  ).not.toBe(true)

  act(() => { vi.advanceTimersByTime(LOADING_PILL_SHOW_AFTER_MS + 50) })
  expect(textOf(renderer)).toContain('Loading tasks…')
  expect(textOf(renderer)).toContain('Show more')
  expect(textOf(renderer)).toContain('PROJECTS')

  // The loader also resolves after a handled RPC failure with no cursor update.
  await act(async () => { finish() })
  expect(textOf(renderer)).not.toContain('Loading tasks…')
  expect(textOf(renderer)).toContain('Show more')
})

it('spins the show-more row instead of a page banner when the user asks for more', async () => {
  let finish!: () => void
  loadPage.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  useSessionStore.setState({ snapshot: snapshot({
    sync_index: { ...pagingIndex, cursors: { 'workspace-1:last_updated': 5 } },
  }) })
  const renderer = renderComponent(<SidebarView
    groups={[{ workspace: workspace(), threads: [] }]}
    selectedThreadId={null} onSelectThread={vi.fn()} onNewThread={vi.fn()}
  />)
  expect(loadPage).not.toHaveBeenCalled()
  expect(textOf(renderer)).toContain('Show more')

  act(() => {
    renderer.root.findByProps({ accessibilityLabel: 'Show more' }).props.onPress()
  })
  expect(loadPage).toHaveBeenCalledWith('workspace-1', 'last_updated', 10)
  expect(
    renderer.root.findByProps({ accessibilityLabel: 'Show more' }).props.accessibilityState,
  ).toEqual(expect.objectContaining({ busy: true, disabled: true }))
  expect(textOf(renderer)).toContain('Show more')

  act(() => { vi.advanceTimersByTime(LOADING_PILL_SHOW_AFTER_MS + 50) })
  expect(textOf(renderer)).not.toContain('Loading tasks…')

  await act(async () => { finish() })
  expect(
    renderer.root.findByProps({ accessibilityLabel: 'Show more' }).props.accessibilityState?.busy,
  ).not.toBe(true)
})

it('follows the first-page fetch with a larger page when show more joins it', async () => {
  const finishes: Array<() => void> = []
  loadPage.mockImplementation(() => new Promise<void>(resolve => { finishes.push(resolve) }))
  isInFlight.mockReturnValue(true)
  useSessionStore.setState({ snapshot: snapshot({
    sync_index: { ...pagingIndex, cursors: { 'workspace-1:last_updated': 5 } },
  }) })
  const renderer = renderComponent(<SidebarView
    groups={[{ workspace: workspace(), threads: [] }]}
    selectedThreadId={null} onSelectThread={vi.fn()} onNewThread={vi.fn()}
  />)

  act(() => {
    renderer.root.findByProps({ accessibilityLabel: 'Show more' }).props.onPress()
  })
  expect(loadPage).toHaveBeenCalledTimes(1)

  await act(async () => { finishes[0]!() })
  expect(loadPage).toHaveBeenCalledTimes(2)
  expect(loadPage).toHaveBeenLastCalledWith('workspace-1', 'last_updated', 10)

  await act(async () => { finishes[1]!() })
  expect(
    renderer.root.findByProps({ accessibilityLabel: 'Show more' }).props.accessibilityState?.busy,
  ).not.toBe(true)
})

it('renders one Chats control and pages each unfinished chat workspace', async () => {
  const ids = ['chat-a', 'chat-b', 'chat-c', 'chat-d']
  useSessionStore.setState({ snapshot: snapshot({
    sync_index: {
      ...pagingIndex,
      counts: Object.fromEntries(ids.map(id => [
        id, { total: 10, running: 0, unread: 0, awaiting: 0 },
      ])),
      cursors: Object.fromEntries(ids.map(id => [`${id}:last_updated`, 5])),
    },
  }) })
  loadPage.mockImplementation(async (workspaceId: string) => {
    const current = useSessionStore.getState().snapshot!
    useSessionStore.setState({ snapshot: {
      ...current,
      sync_index: {
        ...current.sync_index!,
        cursors: { ...current.sync_index!.cursors, [`${workspaceId}:last_updated`]: null },
      },
    } })
  })
  const renderer = renderComponent(<SidebarView
    groups={ids.map(id => ({ workspace: workspace({ id, kind: 'casual' }), threads: [] }))}
    selectedThreadId={null} onSelectThread={vi.fn()} onNewThread={vi.fn()}
  />)

  expect(loadPage).not.toHaveBeenCalled()
  for (const id of ids) {
    expect(textOf(renderer).match(/Show more/g)).toHaveLength(1)
    await act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Show more' }).props.onPress()
    })
    expect(loadPage).toHaveBeenLastCalledWith(id, 'last_updated', 10)
  }
  expect(loadPage).toHaveBeenCalledTimes(4)
  expect(textOf(renderer)).not.toContain('Show more')
})
