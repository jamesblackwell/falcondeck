import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, renderComponent } from '@/test/render'
import { snapshot, thread, threadUpdatedEvent, workspace } from '@/test/factories'
import { useSessionStore, useRelayStore } from '@/store'

const mocks = vi.hoisted(() => ({ buildRows: vi.fn(), buildGroups: vi.fn(), sortGroups: vi.fn(), status: 'closed', permanent: false }))
vi.mock('expo-router', () => ({ usePathname: () => '/', useRouter: () => ({ navigate: () => {} }) }))
vi.mock('@react-navigation/drawer', () => ({ useDrawerStatus: () => mocks.status }))
vi.mock('@/hooks/useTabletLayout', () => ({ useTabletLayout: () => ({ hasPermanentSidebar: mocks.permanent }) }))
vi.mock('@react-navigation/native', () => ({ DrawerActions: { closeDrawer: () => ({ type: 'CLOSE_DRAWER' }) } }))
vi.mock('./sidebarRows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sidebarRows')>()
  return { ...actual, buildSidebarRows: (...args: Parameters<typeof actual.buildSidebarRows>) => {
    mocks.buildRows()
    return actual.buildSidebarRows(...args)
  } }
})
vi.mock('@falcondeck/client-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@falcondeck/client-core')>()
  return {
    ...actual,
    buildProjectGroups: (...args: Parameters<typeof actual.buildProjectGroups>) => {
      mocks.buildGroups()
      return actual.buildProjectGroups(...args)
    },
    sortProjectGroupThreads: (...args: Parameters<typeof actual.sortProjectGroupThreads>) => {
      mocks.sortGroups()
      return actual.sortProjectGroupThreads(...args)
    },
  }
})
import { SidebarDrawerContent } from './SidebarDrawerContent'

const relayState = useRelayStore.getState()
afterEach(() => {
  cleanup()
  useSessionStore.getState().reset()
  useRelayStore.setState(relayState)
  mocks.status = 'closed'
  mocks.permanent = false
  vi.clearAllMocks()
  vi.useRealTimers()
})
function setup() {
  vi.useFakeTimers()
  const base = thread({ status: 'running' })
  useSessionStore.setState({ snapshot: snapshot({ threads: [base], sync_index: {
    token: 'performance-index', counts: { 'workspace-1': { total: 1, running: 1, unread: 0, awaiting: 0 } },
    cursors: { 'workspace-1:last_updated': null }, touched_threads: {}, touched_views: {},
    catalog_touched: false, extensions_loaded: true,
  } }), selectedWorkspaceId: 'workspace-1', selectedThreadId: 'thread-1' })
  useRelayStore.setState({ hasSyncedOnce: true, isEncrypted: true, sessionId: 'demo-session' })
  return base
}
const drawer = () => <SidebarDrawerContent navigation={{ dispatch: () => {} } as never} />

it('opens a large sidebar without sorting the inventory before row derivation sorts it', () => {
  setup()
  mocks.status = 'open'
  const workspaces = Array.from({ length: 72 }, (_, index) => workspace({ id: `w${index}`, path: `/tmp/p${index}` }))
  const threads = workspaces.flatMap((item, index) => Array.from({ length: index < 46 ? 38 : 37 }, (_, threadIndex) =>
    thread({ id: `${item.id}-t${threadIndex}`, workspace_id: item.id }),
  ))
  useSessionStore.setState({ snapshot: snapshot({
    workspaces,
    threads,
    sync_index: {
      token: 'large-index',
      counts: {},
      cursors: Object.fromEntries(workspaces.map(item => [`${item.id}:last_updated`, null])),
      touched_threads: {}, touched_views: {}, catalog_touched: false, extensions_loaded: true,
    },
  }) })
  renderComponent(drawer())
  expect(mocks.buildGroups).toHaveBeenCalledTimes(1)
  expect(mocks.buildRows).toHaveBeenCalledTimes(1)
  expect(mocks.sortGroups).not.toHaveBeenCalled()
})

it('does no group or row rebuilds behind a closed drawer, then catches up when opened', async () => {
  const base = setup()
  const renderer = renderComponent(drawer())
  await act(async () => { await Promise.resolve() })
  mocks.buildRows.mockClear()
  mocks.buildGroups.mockClear()
  for (let index = 1; index <= 30; index++) {
    act(() => useSessionStore.getState().applyDaemonEvent(threadUpdatedEvent({
      ...base, updated_at: '2026-09-29T10:00:' + String(index).padStart(2, '0') + 'Z',
      attention: { ...base.attention, last_agent_activity_seq: index },
    })))
  }
  for (let index = 0; index < 4; index++) {
    act(() => {
      useSessionStore.getState().applyDaemonEvent(threadUpdatedEvent({
        ...base, last_message_preview: 'Progress ' + index, updated_at: '2026-09-29T10:01:0' + index + 'Z',
      }))
      vi.advanceTimersByTime(250)
    })
  }
  expect(mocks.buildRows).not.toHaveBeenCalled()
  expect(mocks.buildGroups).not.toHaveBeenCalled()
  mocks.status = 'open'
  act(() => renderer.update(drawer()))
  expect(mocks.buildGroups).toHaveBeenCalledTimes(1)
  expect(mocks.buildRows).toHaveBeenCalled()
})

it.each([false, true])('throttles visible rows, including permanent sidebars (%s)', async permanent => {
  const base = setup()
  mocks.status = permanent ? 'closed' : 'open'
  mocks.permanent = permanent
  renderComponent(drawer())
  await act(async () => { await Promise.resolve() })
  mocks.buildRows.mockClear()
  mocks.buildGroups.mockClear()
  act(() => {
    for (let index = 0; index < 30; index++) {
      useSessionStore.getState().applyDaemonEvent(threadUpdatedEvent({
        ...base, title: 'chunk ' + index, updated_at: '2026-09-29T10:00:00Z',
      }))
    }
  })
  expect(mocks.buildGroups).not.toHaveBeenCalled()
  expect(mocks.buildRows).not.toHaveBeenCalled()
  act(() => { vi.advanceTimersByTime(250) })
  expect(mocks.buildGroups).toHaveBeenCalledTimes(1)
  expect(mocks.buildRows).toHaveBeenCalledTimes(1)
})
