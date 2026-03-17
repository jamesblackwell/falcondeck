import { useCallback } from 'react'

import type { EncryptedEnvelope } from '@falcondeck/client-core'

import { useRelayStore, useSessionStore, useUIStore } from '@/store'

export function useSessionActions() {
  const submitTurn = useCallback(async () => {
    const relay = useRelayStore.getState()
    const session = useSessionStore.getState()
    const ui = useUIStore.getState()

    const workspace = session.snapshot?.workspaces.find((w) => w.id === session.selectedWorkspaceId)
    if (!workspace || !ui.draft.trim()) return

    ui.setIsSubmitting(true)

    try {
      const threadId = session.selectedThreadId
      if (!threadId) return

      const turnParams = {
        workspace_id: workspace.id,
        thread_id: threadId,
        inputs: [{ type: 'text', text: ui.draft }],
        model_id: ui.selectedModel,
        reasoning_effort: ui.selectedEffort,
        collaboration_mode_id: ui.selectedCollaborationMode,
        approval_policy: 'on-request',
      }

      relay._sendMessage({
        type: 'rpc-call',
        request_id: `mobile-${Date.now()}`,
        method: 'turn.start',
        params: await relay._encryptJson(turnParams),
      })

      ui.clearDraft()
    } catch (e) {
      relay._setError(e instanceof Error ? e.message : 'Failed to send message')
    } finally {
      ui.setIsSubmitting(false)
    }
  }, [])

  const respondApproval = useCallback(async (requestId: string, decision: 'allow' | 'deny') => {
    const relay = useRelayStore.getState()
    const session = useSessionStore.getState()
    const workspace = session.snapshot?.workspaces.find((w) => w.id === session.selectedWorkspaceId)
    if (!workspace) return

    try {
      relay._sendMessage({
        type: 'rpc-call',
        request_id: `mobile-approval-${Date.now()}`,
        method: 'approval.respond',
        params: await relay._encryptJson({
          workspace_id: workspace.id,
          request_id: requestId,
          decision,
        }),
      })
    } catch (e) {
      relay._setError(e instanceof Error ? e.message : 'Approval action failed')
    }
  }, [])

  const loadThreadDetail = useCallback(async (workspaceId: string, threadId: string) => {
    const relay = useRelayStore.getState()

    try {
      relay._sendMessage({
        type: 'rpc-call',
        request_id: `mobile-detail-${Date.now()}`,
        method: 'thread.detail',
        params: await relay._encryptJson({
          workspace_id: workspaceId,
          thread_id: threadId,
        }),
      })
    } catch (e) {
      relay._setError(e instanceof Error ? e.message : 'Failed to load thread')
    }
  }, [])

  return { submitTurn, respondApproval, loadThreadDetail }
}
