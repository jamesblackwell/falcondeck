import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, renderComponent, textOf } from '@/test/render'
import { snapshot, workspace } from '@/test/factories'
import { useSessionStore } from '@/store'
import { SidebarView } from './SidebarView'

const { loadPage } = vi.hoisted(() => ({ loadPage: vi.fn() }))
vi.mock('@/hooks/sync-index', () => ({ loadSyncThreadPage: loadPage }))
vi.mock('@/hooks/useSessionSyncStatus', () => ({
  useSessionSyncStatus: () => ({ isBusy: false, stage: 'ready' }),
}))
const initialSnapshot = useSessionStore.getState().snapshot

afterEach(() => {
  cleanup()
  useSessionStore.setState({ snapshot: initialSnapshot })
  vi.clearAllMocks()
})

it('shows page activity after snapshot sync and clears it when the request settles', async () => {
  let finish!: () => void
  loadPage.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  useSessionStore.setState({ snapshot: snapshot({
    sync_index: { token: 'index-1', cursors: {}, touched_threads: {}, touched_views: {}, catalog_touched: false, extensions_loaded: false, counts: {
      'workspace-1': { total: 10, running: 0, unread: 0, awaiting: 0 },
    } },
  }) })
  const renderer = renderComponent(<SidebarView
    groups={[{ workspace: workspace(), threads: [] }]}
    selectedThreadId={null} onSelectThread={vi.fn()} onNewThread={vi.fn()}
  />)
  expect(loadPage).toHaveBeenCalledWith('workspace-1', 'last_updated', 5)
  expect(textOf(renderer)).toContain('Loading tasks…')
  const more = renderer.root.findAllByProps({ accessibilityRole: 'button' })
    .find(node => node.props.accessibilityState?.busy)
  expect(more?.props.disabled).toBe(true)

  // The loader also resolves after a handled RPC failure with no cursor update.
  await act(async () => { finish() })
  expect(textOf(renderer)).not.toContain('Loading tasks…')
  expect(textOf(renderer)).toContain('Show more')
})
