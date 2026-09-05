import { beforeEach, expect, it, vi } from 'vitest'
import { expandSyncIndex } from '@falcondeck/client-core'
import { useRelayStore, useSessionStore } from '@/store'
import { snapshot, thread } from '@/test/factories'
import { loadSyncThreadPage, requestInitialSync } from './sync-index'

const originalRpc = useRelayStore.getState()._callRpc
beforeEach(() => {
  useSessionStore.getState().reset()
  useRelayStore.getState()._callRpc = originalRpc
})

it('falls back only for an unavailable method, never for a timeout', async () => {
  const legacy = vi.fn().mockResolvedValue(snapshot())
  const unavailable = Object.assign(new Error('relay rpc method is unavailable'), { failure: 'method_unavailable' })
  const rpc = vi.fn().mockRejectedValue(unavailable) as unknown as typeof originalRpc
  await requestInitialSync({ _callRpc: rpc }, null, legacy)
  expect(legacy).toHaveBeenCalledOnce()
  legacy.mockClear()
  vi.mocked(rpc).mockRejectedValue(new Error('Timed out waiting for a response'))
  await expect(requestInitialSync({ _callRpc: rpc }, null, legacy)).rejects.toThrow('Timed out')
  expect(legacy).not.toHaveBeenCalled()
})

it('joins duplicate page loads and ignores a response from a replaced index', async () => {
  const initial = expandSyncIndex({ token: 'old', snapshot: snapshot({ threads: [] }), agent_catalogs: [], model_catalogs: [], workspace_agents: {}, workspace_models: {}, counts: {} })
  useSessionStore.setState({ snapshot: initial })
  let complete!: (value: unknown) => void
  const call = vi.fn().mockImplementation(() => new Promise(resolve => { complete = resolve }))
  useRelayStore.getState()._callRpc = call as typeof originalRpc
  const first = loadSyncThreadPage('workspace-1')
  const second = loadSyncThreadPage('workspace-1')
  expect(call).toHaveBeenCalledOnce()
  useSessionStore.setState({ snapshot: { ...initial, sync_index: { ...initial.sync_index!, token: 'new' } } })
  complete({ token: 'old', workspace_id: 'workspace-1', threads: [thread()], next_cursor: null })
  await Promise.all([first, second])
  expect(useSessionStore.getState().snapshot?.threads).toEqual([])
})
