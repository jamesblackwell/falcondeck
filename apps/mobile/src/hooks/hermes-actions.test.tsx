import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { normalizeThreadSummary, normalizeWorkspaceSummary } from '@falcondeck/client-core'
import fixture from '../../../../packages/client-core/src/test-fixtures/hermes.json'
import { snapshot } from '@/test/factories'
import { cleanup, renderComponent } from '@/test/render'
import { useRelayStore } from '@/store/relay-store'
import { useSessionStore } from '@/store/session-store'
import { useUIStore } from '@/store/ui-store'
import { useSessionActions } from './useSessionActions'
import { useThreadActions } from './useThreadActions'

afterEach(() => { cleanup(); useSessionStore.getState().reset(); useUIStore.getState().setSelectedCollaborationMode(null) })

it('sends native modes when creating and updating Hermes threads, and clears them between conversations', async () => {
  const workspace = normalizeWorkspaceSummary({ id: 'hermes-workspace', default_provider: 'hermes', agents: [fixture.agent] })
  const thread = normalizeThreadSummary(fixture.thread)
  useSessionStore.setState({ snapshot: snapshot({ workspaces: [workspace] }), selectedWorkspaceId: workspace.id })
  useUIStore.getState().setConversation(workspace.id, null)
  useUIStore.setState({ selectedProvider: 'hermes', selectedModel: 'openai-codex:gpt-5.6-luna', selectedCollaborationMode: 'accept_edits' })
  const rpc = vi.fn().mockResolvedValue({ workspace, thread })
  useRelayStore.setState({ _callRpc: rpc })
  let sessions!: ReturnType<typeof useSessionActions>
  let threads!: ReturnType<typeof useThreadActions>
  function Harness() { sessions = useSessionActions(); threads = useThreadActions(); return null }
  renderComponent(<Harness />)
  await act(async () => { await sessions.startThread() })
  expect(rpc).toHaveBeenCalledWith('thread.start', expect.objectContaining({ provider: 'hermes', collaboration_mode_id: 'accept_edits' }), expect.anything())
  await act(async () => { await threads.setThreadMode(workspace.id, thread.id, 'collaboration_mode_id', 'dont_ask') })
  expect(rpc).toHaveBeenLastCalledWith('thread.update', { workspace_id: workspace.id, thread_id: thread.id, collaboration_mode_id: 'dont_ask' }, expect.anything())
  rpc.mockRejectedValueOnce(new Error('Native mode rejected'))
  await act(async () => { await expect(threads.setThreadMode(workspace.id, thread.id, 'collaboration_mode_id', 'unknown')).rejects.toThrow('Native mode rejected') })
  expect(useRelayStore.getState().error).toBe('Native mode rejected')
  useUIStore.getState().setSelectedCollaborationMode('dont_ask')
  useUIStore.getState().setConversation(workspace.id, 'another-thread')
  expect(useUIStore.getState().selectedCollaborationMode).toBeNull()
})
