import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderComponent, renderPure, cleanup, textOf } from '../../test/render'
import { ConnectionHeader } from './ConnectionHeader'
import { SidebarView } from './SidebarView'
import { workspace, thread } from '../../test/factories'
import type { ProjectGroup } from '@falcondeck/client-core'

afterEach(cleanup)

describe('ConnectionHeader component', () => {
  it('renders encrypted', () => {
    expect(renderPure(ConnectionHeader, { connectionStatus: 'encrypted', isEncrypted: true, machinePresence: { session_id: 's1', daemon_connected: true, last_seen_at: null } })).toBeTruthy()
  })
  it('renders disconnected', () => {
    expect(renderPure(ConnectionHeader, { connectionStatus: 'disconnected', isEncrypted: false, machinePresence: null })).toBeTruthy()
  })
  it('renders connecting', () => {
    expect(renderPure(ConnectionHeader, { connectionStatus: 'connecting', isEncrypted: false, machinePresence: null })).toBeTruthy()
  })
  it('renders connected not encrypted', () => {
    expect(renderPure(ConnectionHeader, { connectionStatus: 'connected', isEncrypted: false, machinePresence: { session_id: 's1', daemon_connected: false, last_seen_at: null } })).toBeTruthy()
  })
  it('renders not_connected', () => {
    expect(renderPure(ConnectionHeader, { connectionStatus: 'not_connected', isEncrypted: false, machinePresence: null })).toBeTruthy()
  })
})

describe('SidebarView component', () => {
  const base = {
    groups: [] as ProjectGroup[],
    selectedWorkspaceId: null as string | null,
    selectedThreadId: null as string | null,
    connectionStatus: 'encrypted',
    isEncrypted: true,
    onSelectThread: vi.fn(),
    onNewThread: vi.fn(),
  }

  it('renders empty', () => {
    const r = renderComponent(<SidebarView {...base} />)
    expect(textOf(r)).toContain('No projects')
  })
  it('renders groups', () => {
    const groups: ProjectGroup[] = [{ workspace: workspace({ id: 'w1', path: '/tmp/proj' }), threads: [thread({ id: 't1', workspace_id: 'w1' })] }]
    const r = renderComponent(<SidebarView {...base} groups={groups} />)
    expect(textOf(r)).toContain('proj')
  })
  it('renders selected', () => {
    const groups: ProjectGroup[] = [{ workspace: workspace({ id: 'w1' }), threads: [thread({ id: 't1', workspace_id: 'w1' })] }]
    expect(renderComponent(<SidebarView {...base} groups={groups} selectedWorkspaceId="w1" selectedThreadId="t1" />).toJSON()).toBeTruthy()
  })
  it('renders disconnected', () => {
    expect(renderComponent(<SidebarView {...base} connectionStatus="disconnected" isEncrypted={false} />).toJSON()).toBeTruthy()
  })
  it('renders connecting', () => {
    expect(renderComponent(<SidebarView {...base} connectionStatus="connecting" isEncrypted={false} />).toJSON()).toBeTruthy()
  })
  it('renders empty-titled thread', () => {
    const groups: ProjectGroup[] = [{ workspace: workspace({ id: 'w1' }), threads: [thread({ id: 't1', workspace_id: 'w1', title: '' })] }]
    expect(renderComponent(<SidebarView {...base} groups={groups} />).toJSON()).toBeTruthy()
  })
})
