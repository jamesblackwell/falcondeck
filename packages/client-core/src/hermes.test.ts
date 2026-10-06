import { describe, expect, it } from 'vitest'
import fixture from './test-fixtures/hermes.json'
import { normalizeConversationItem, normalizeInteractiveRequest, normalizeThreadSummary, normalizeWorkspaceSummary } from './normalization'
import { imageAttachmentSendBlockReason, workspaceCollaborationModes } from './collaboration'

describe('qualified Hermes projection', () => {
  it('keeps native identities and opaque modes when additive fields arrive', () => {
    const workspace = normalizeWorkspaceSummary({ agents: [{ ...fixture.agent, future_setting: { revision: 2 } }] })
    const thread = normalizeThreadSummary({ ...fixture.thread, future_provenance: ['native'] })
    expect(thread.provider).toBe('hermes')
    expect(thread.native_session_id).toBe('native-hermes-session')
    expect(workspaceCollaborationModes(workspace, 'hermes').map(mode => mode.id)).toEqual(['default', 'accept_edits', 'dont_ask'])
    expect(workspace.agents[0]!.models[0]!.id).toBe('openai-codex:gpt-5.6-luna')
    const diff = normalizeConversationItem({ ...fixture.diff, future_setting: true })
    expect(diff).toMatchObject({ kind: 'file_change', changes: [{ path: 'hermes-allowed.txt', diff: expect.stringContaining('+FALCONDECK_EDIT_OK') }] })
  })

  it('retains exact approval IDs and falls back to decisions for older projections', () => {
    const request = normalizeInteractiveRequest({ ...fixture.request, future_context: { revision: 2 } })
    expect(request?.approval_options?.map(option => option.option_id)).toEqual(['allow_once', 'deny'])
    const { approval_options: _options, ...older } = fixture.request
    const fallback = normalizeInteractiveRequest(older)
    expect(fallback?.approval_options).toBeUndefined()
    expect(fallback?.approval_decisions).toEqual(['allow', 'deny'])
    expect(request?.path).toBe('hermes-allowed.txt')
  })

  it('allows images only when negotiated, with a usable fallback for older daemons', () => {
    const image = { type: 'image' as const, id: 'image', name: 'shape.png', mime_type: 'image/png', url: 'data:image/png;base64,AA==' }
    const workspace = normalizeWorkspaceSummary({ agents: [fixture.agent] })
    expect(imageAttachmentSendBlockReason(workspace.agents[0]!.capabilities!, [image])).toBeNull()
    const older = normalizeWorkspaceSummary({ agents: [{ provider: 'hermes' }] })
    expect(imageAttachmentSendBlockReason(older.agents[0]!.capabilities!, [image])).toContain('Remove the image or choose an agent')
  })
})
