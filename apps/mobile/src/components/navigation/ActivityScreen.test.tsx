import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, renderComponent, textOf } from '@/test/render'
import { snapshot, thread } from '@/test/factories'
import { useSessionStore } from '@/store'
import ActivityScreen from '@/app/(app)/activity'

const { navigate, loadPage } = vi.hoisted(() => ({ navigate: vi.fn(), loadPage: vi.fn() }))
vi.mock('expo-router', () => ({ useRouter: () => ({ navigate }) }))
vi.mock('@/hooks/useSessionSyncStatus', () => ({ useSessionSyncStatus: () => ({ isBusy: false, stage: 'ready' }) }))
vi.mock('@/hooks/sync-index', () => ({ loadSyncThreadPage: loadPage }))

afterEach(() => { cleanup(); useSessionStore.getState().reset(); vi.clearAllMocks() })

it('orders task states, excludes archived tasks, and opens the selected conversation', () => {
  const attention = thread().attention
  useSessionStore.setState({ snapshot: snapshot({ threads: [
    thread({ id: 'running', title: 'Running task', status: 'running' }),
    thread({ id: 'ready', title: 'Ready task', attention: { ...attention, unread: true } }),
    thread({ id: 'failed', title: 'Failed task', status: 'error', last_error: 'Command failed', attention: { ...attention, level: 'error', unread: true } }),
    thread({ id: 'blocked', title: 'Blocked task', attention: { ...attention, pending_question_count: 1 } }),
    thread({ id: 'archived', title: 'Archived task', status: 'running', is_archived: true }),
  ] }) })
  const renderer = renderComponent(<ActivityScreen />)
  const text = textOf(renderer)
  expect(text.indexOf('Needs input')).toBeLessThan(text.indexOf('Failed task'))
  expect(text.indexOf('Failed task')).toBeLessThan(text.indexOf('Ready task'))
  expect(text.indexOf('Ready task')).toBeLessThan(text.indexOf('Running task'))
  expect(text).toContain('Command failed')
  expect(text).not.toContain('Archived task')
  const button = renderer.root.findAllByProps({ accessibilityRole: 'button' }).find(node => node.props.accessibilityLabel?.startsWith('Blocked task,'))!
  act(() => button.props.onPress())
  expect(useSessionStore.getState().selectedWorkspaceId).toBe('workspace-1')
  expect(useSessionStore.getState().selectedThreadId).toBe('blocked')
  expect(navigate).toHaveBeenCalledWith('/(app)')
})

it('distinguishes a partial empty queue and loads additional tasks', async () => {
  useSessionStore.setState({ snapshot: snapshot({ threads: [], sync_index: {
    token: 'index', cursors: {}, touched_threads: {}, touched_views: {}, catalog_touched: false, extensions_loaded: false,
    counts: { 'workspace-1': { total: 75, running: 1, unread: 1, awaiting: 0 } },
  } }) })
  const renderer = renderComponent(<ActivityScreen />)
  expect(textOf(renderer)).toContain('No activity in loaded tasks')
  expect(textOf(renderer)).not.toContain('All caught up')
  await act(async () => renderer.root.findByProps({ label: 'Load more tasks' }).props.onPress())
  expect(loadPage).toHaveBeenCalledWith('workspace-1', 'last_updated', 50)
})

it('shows recent completed work without duplicating unread results', () => {
  const attention = { ...thread().attention, last_agent_activity_seq: 2, last_read_seq: 2 }
  useSessionStore.setState({ snapshot: snapshot({ threads: [
    thread({ id: 'recent', title: 'Finished task', updated_at: new Date().toISOString(), attention }),
    thread({ id: 'ready', title: 'Unread task', updated_at: new Date().toISOString(), attention: { ...attention, unread: true } }),
  ] }) })
  const renderer = renderComponent(<ActivityScreen />)
  expect(textOf(renderer)).toContain('Recent')
  expect(textOf(renderer)).toContain('Finished task')
  expect(textOf(renderer).match(/Unread task/g)).toHaveLength(1)
})
