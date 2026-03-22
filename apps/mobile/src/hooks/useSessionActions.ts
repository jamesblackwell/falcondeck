import { useCallback } from 'react'

import { normalizeThreadDetail, normalizeThreadHandle } from '@falcondeck/client-core'
import type { ThreadDetail, ThreadHandle } from '@falcondeck/client-core'

import { useRelayStore, useSessionStore, useUIStore } from '@/store'

export function useSessionActions() {
  const submitTurn = useCallback(async () => {
    const relay = useRelayStore.getState()
    const session = useSessionStore.getState()
    const ui = useUIStore.getState()

    const workspace = session.snapshot?.workspaces.find((w) => w.id === session.selectedWorkspaceId)
    const submittedDraft = ui.draft.trim()
    if (!workspace || !submittedDraft) return

    ui.setIsSubmitting(true)
    // Clear draft immediately so the input feels responsive — text is already
    // captured in submittedDraft above.
    ui.clearDraft()

    try {
      const threadId = session.selectedThreadId
      let activeThreadId = threadId
      if (!activeThreadId) {
        const handle = normalizeThreadHandle(
          await relay._callRpc<ThreadHandle>(
            'thread.start',
            {
              workspace_id: workspace.id,
              provider: ui.selectedProvider ?? workspace.default_provider,
              model_id: ui.selectedModel,
              collaboration_mode_id: ui.selectedCollaborationMode,
              approval_policy: 'on-request',
            },
            { requestIdPrefix: 'mobile-thread' },
          ),
        )
        activeThreadId = handle.thread.id
        useSessionStore.getState().selectThread(handle.workspace.id, handle.thread.id)
      }

      const turnParams = {
        workspace_id: workspace.id,
        thread_id: activeThreadId,
        inputs: [{ type: 'text', text: submittedDraft }],
        provider: ui.selectedProvider ?? workspace.default_provider,
        model_id: ui.selectedModel,
        reasoning_effort: ui.selectedEffort,
        collaboration_mode_id: ui.selectedCollaborationMode,
        approval_policy: 'on-request',
      }

      await relay._callRpc('turn.start', turnParams, {
        requestIdPrefix: 'mobile-turn',
      })
      relay._setError(null)
    } catch (e) {
      // Restore draft on failure so the user doesn't lose their message
      ui.setDraft(submittedDraft)
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
      await relay._callRpc(
        'approval.respond',
        {
          workspace_id: workspace.id,
          request_id: requestId,
          decision,
        },
        { requestIdPrefix: 'mobile-approval' },
      )
      relay._setError(null)
    } catch (e) {
      relay._setError(e instanceof Error ? e.message : 'Approval action failed')
    }
  }, [])

  const loadThreadDetail = useCallback(async (workspaceId: string, threadId: string) => {
    const relay = useRelayStore.getState()

    try {
      const detail = normalizeThreadDetail(
        await relay._callRpc<ThreadDetail>(
          'thread.detail',
          {
          workspace_id: workspaceId,
          thread_id: threadId,
          },
          { requestIdPrefix: 'mobile-detail' },
        ),
      )
      useSessionStore.getState().setThreadDetail(detail)
      relay._setError(null)
    } catch (e) {
      relay._setError(e instanceof Error ? e.message : 'Failed to load thread')
    }
  }, [])

  return { submitTurn, respondApproval, loadThreadDetail }
}
