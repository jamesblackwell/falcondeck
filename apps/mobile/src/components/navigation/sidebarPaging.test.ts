import { expect, it } from 'vitest'
import { buildSidebarRows } from './sidebarRows'
import { thread, workspace } from '@/test/factories'

it('keeps more available while a frozen page cursor remains, even after live inserts change counts', () => {
  const rows = buildSidebarRows([{ workspace: workspace(), threads: [thread()] }], new Set(), new Map(), null, 'last_updated', false, false,
    { 'workspace-1': { total: 1, running: 0, unread: 0, awaiting: 0 } }, { 'workspace-1:last_updated': 10 })
  expect(rows.some(row => row.type === 'overflow')).toBe(true)
})

it('makes unloaded casual chats accessible and removes more when scope is complete', () => {
  const groups = [{ workspace: workspace({ kind: 'casual' }), threads: [] }]
  const counts = { 'workspace-1': { total: 50, running: 0, unread: 0, awaiting: 0 } }
  const rows = buildSidebarRows(groups, new Set(), new Map(), null, 'last_updated', true, false, counts)
  expect(rows.some(row => row.type === 'overflow' && row.workspaceId === 'workspace-1')).toBe(true)
  const complete = buildSidebarRows(groups, new Set(), new Map(), null, 'last_updated', true, false, counts, { 'workspace-1:last_updated': null })
  expect(complete.some(row => row.type === 'overflow')).toBe(false)
})
