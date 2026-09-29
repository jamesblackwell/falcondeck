import React, { useEffect } from 'react'
import { act } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { buildProjectGroups, type ProjectGroup } from '@falcondeck/client-core'
import { cleanup, renderComponent } from '@/test/render'
import { snapshot, thread } from '@/test/factories'
import { useRelayStore, useSessionStore } from '@/store'
import { useWorkspaceIcons } from './useWorkspaceIcons'

const relayState = useRelayStore.getState()
let uri: string | null
function Harness({ groups, paused = false }: { groups: ProjectGroup[]; paused?: boolean }) {
  const lookup = useWorkspaceIcons(groups, paused)
  useEffect(() => { uri = lookup('workspace-1') }, [lookup])
  return null
}
function groups(etag = 'same', title = 'thread') {
  return buildProjectGroups([{ ...snapshot().workspaces[0], icon: { kind: 'image', etag } }],
    [thread({ title })])
}
const payload = { kind: 'image', content_type: 'image/png', data: 'dGVzdA==' }
beforeEach(() => { useRelayStore.setState({ sessionId: 'icon-session', isEncrypted: true }) })
afterEach(() => {
  cleanup()
  useSessionStore.getState().reset()
  useRelayStore.setState(relayState)
  vi.restoreAllMocks()
})

it('shares one slow request across unrelated group updates', async () => {
  let resolve!: (value: typeof payload) => void
  const rpc = vi.fn(() => new Promise<typeof payload>(done => { resolve = done }))
  useRelayStore.setState({ _callRpc: rpc as never })
  const renderer = renderComponent(<Harness groups={groups()} />)
  for (let index = 0; index < 8; index++) {
    act(() => renderer.update(<Harness groups={groups('same', String(index))} />))
  }
  expect(rpc).toHaveBeenCalledTimes(1)
  await act(async () => { resolve(payload) })
  expect(uri).toBe('data:image/png;base64,dGVzdA==')
})

it('keeps a response when visibility changes and reuses it on reopening', async () => {
  let resolve!: (value: typeof payload) => void
  const rpc = vi.fn(() => new Promise<typeof payload>(done => { resolve = done }))
  useRelayStore.setState({ _callRpc: rpc as never })
  const renderer = renderComponent(<Harness groups={groups()} />)
  act(() => renderer.update(<Harness groups={groups()} paused />))
  await act(async () => { resolve(payload) })
  act(() => renderer.update(<Harness groups={groups()} />))
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(uri).toBe('data:image/png;base64,dGVzdA==')
})

it('isolates icon versions and pairings, including late responses', async () => {
  const pending: ((value: typeof payload) => void)[] = []
  const rpc = vi.fn(() => new Promise<typeof payload>(done => pending.push(done)))
  useRelayStore.setState({ _callRpc: rpc as never })
  const renderer = renderComponent(<Harness groups={groups()} />)
  act(() => renderer.update(<Harness groups={groups('new')} />))
  await act(async () => { pending[0](payload) })
  expect(uri).toBeNull()
  await act(async () => { pending[1]({ ...payload, data: 'bmV3' }) })
  expect(uri).toBe('data:image/png;base64,bmV3')
  act(() => useRelayStore.setState({ sessionId: 'another-session' }))
  expect(uri).toBeNull()
  expect(rpc).toHaveBeenCalledTimes(3)
  await act(async () => { pending[2]({ ...payload, data: 'b3RoZXI=' }) })
  expect(uri).toBe('data:image/png;base64,b3RoZXI=')
})

it('retries a failed request after reconnecting', async () => {
  const rpc = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(payload)
  useRelayStore.setState({ _callRpc: rpc })
  renderComponent(<Harness groups={groups()} />)
  await act(async () => { await Promise.resolve() })
  act(() => useRelayStore.setState({ isEncrypted: false }))
  await act(async () => { useRelayStore.setState({ isEncrypted: true }) })
  expect(rpc).toHaveBeenCalledTimes(2)
  expect(uri).toBe('data:image/png;base64,dGVzdA==')
})
