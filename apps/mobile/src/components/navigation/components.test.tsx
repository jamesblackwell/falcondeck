import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderComponent, cleanup, textOf } from '../../test/render'
import { ConnectionHeader } from './ConnectionHeader'
import { SidebarView } from './SidebarView'
import { workspace, thread } from '../../test/factories'
import type { ProjectGroup } from '@falcondeck/client-core'

afterEach(cleanup)

describe('ConnectionHeader component', () => {
  it('renders encrypted', () => {
    const r = renderComponent(<ConnectionHeader connectionStatus="encrypted" isEncrypted machinePresence={{ session_id: 's1', daemon_connected: true, last_seen_at: null }} />)
    expect(textOf(r)).toContain('Connected')
  })
  it('renders disconnected', () => {
    const r = renderComponent(<ConnectionHeader connectionStatus="disconnected" isEncrypted={false} machinePresence={null} />)
    expect(textOf(r)).toContain('Disconnected')
  })
  it('renders connecting', () => {
    const r = renderComponent(<ConnectionHeader connectionStatus="connecting" isEncrypted={false} machinePresence={null} />)
    expect(textOf(r)).toContain('Connecting...')
  })
  it('renders connected not encrypted', () => {
    const r = renderComponent(<ConnectionHeader connectionStatus="connected" isEncrypted={false} machinePresence={{ session_id: 's1', daemon_connected: false, last_seen_at: null }} />)
    expect(textOf(r)).toContain('Desktop offline')
  })
  it('renders not_connected', () => {
    const r = renderComponent(<ConnectionHeader connectionStatus="not_connected" isEncrypted={false} machinePresence={null} />)
    expect(textOf(r)).toContain('Not connected')
  })
})

describe('SidebarView component', () => {
  const base = {
    groups: [] as ProjectGroup[],
    selectedThreadId: null as string | null,
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
    expect(renderComponent(<SidebarView {...base} groups={groups} selectedThreadId="t1" />).toJSON()).toBeTruthy()
  })
  it('renders empty-titled thread', () => {
    const groups: ProjectGroup[] = [{ workspace: workspace({ id: 'w1' }), threads: [thread({ id: 't1', workspace_id: 'w1', title: '' })] }]
    expect(renderComponent(<SidebarView {...base} groups={groups} />).toJSON()).toBeTruthy()
  })
})
