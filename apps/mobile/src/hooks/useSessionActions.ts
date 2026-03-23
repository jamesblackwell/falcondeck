import { useCallback, useRef } from 'react'

import { normalizeThreadDetail, normalizeThreadHandle, selectedSkillsFromText } from '@falcondeck/client-core'
import type { ThreadDetail, ThreadHandle } from '@falcondeck/client-core'

import { useRelayStore, useSessionStore, useUIStore } from '@/store'

const THREAD_TAIL_LIMIT = 150
const THREAD_OLDER_PAGE_LIMIT = 100

export function useSessionActions() {
  const detailRequestVersion = useRef(0)

  const submitTurn = useCallback(async () => {
    const relay = useRelayStore.getState()
    const session = useSessionStore.getState()
    const ui = useUIStore.getState()

    const workspace = session.snapshot?.workspaces.find((w) => w.id === session.selectedWorkspaceId)
    const submittedDraft = ui.draft
    const submittedAttachments = ui.attachments
    if (!workspace || (!submittedDraft.trim() && submittedAttachments.length === 0)) return
    const submittedSkills = selectedSkillsFromText(submittedDraft, workspace.skills ?? [])

    ui.setIsSubmitting(true)
    ui.clearDraft()
    ui.clearAttachments()

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

      await relay._callRpc(
        'turn.start',
        {
          workspace_id: workspace.id,
          thread_id: activeThreadId,
          inputs: [
            ...(submittedDraft.trim() ? [{ type: 'text', text: submittedDraft }] : []),
            ...submittedAttachments,
          ],
          selected_skills: submittedSkills,
          provider: ui.selectedProvider ?? workspace.default_provider,
          model_id: ui.selectedModel,
          reasoning_effort: ui.selectedEffort,
          collaboration_mode_id: ui.selectedCollaborationMode,
          approval_policy: 'on-request',
        },
        { requestIdPrefix: 'mobile-turn' },
      )
      relay._setError(null)
    } catch (e) {
      ui.setDraft(submittedDraft)
      ui.setAttachments(submittedAttachments)
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

  const loadThreadDetail = useCallback(async (
    workspaceId: string,
    threadId: string,
    options?: { older?: boolean },
  ) => {
    const relay = useRelayStore.getState()
    const session = useSessionStore.getState()
    const history = session.threadHistory[threadId]
    const requestVersion = options?.older ? detailRequestVersion.current : detailRequestVersion.current + 1
    if (!options?.older) {
      detailRequestVersion.current = requestVersion
    }

    if (options?.older && !history?.oldestItemId) {
      return null
    }

    try {
      const detail = normalizeThreadDetail(
        await relay._callRpc<ThreadDetail>(
          'thread.detail',
          options?.older
            ? {
                workspace_id: workspaceId,
                thread_id: threadId,
                mode: 'before',
                before_item_id: history?.oldestItemId ?? null,
                limit: THREAD_OLDER_PAGE_LIMIT,
              }
            : {
                workspace_id: workspaceId,
                thread_id: threadId,
                mode: 'tail',
                limit: THREAD_TAIL_LIMIT,
              },
          {
            requestIdPrefix: options?.older ? 'mobile-detail-older' : 'mobile-detail',
          },
        ),
      )

      const activeSession = useSessionStore.getState()
      const isStale =
        (!options?.older && requestVersion !== detailRequestVersion.current) ||
        activeSession.selectedThreadId !== threadId ||
        activeSession.selectedWorkspaceId !== workspaceId

      if (isStale) {
        return null
      }

      useSessionStore.getState().setThreadDetail(detail, {
        mergeMode: options?.older ? 'prepend' : 'refresh',
      })
      relay._setError(null)
      return detail
    } catch (e) {
      const activeSession = useSessionStore.getState()
      const isStale =
        (!options?.older && requestVersion !== detailRequestVersion.current) ||
        activeSession.selectedThreadId !== threadId ||
        activeSession.selectedWorkspaceId !== workspaceId
      if (isStale) {
        return null
      }

      relay._setError(e instanceof Error ? e.message : 'Failed to load thread')
      return null
    }
  }, [])

  return { submitTurn, respondApproval, loadThreadDetail }
}
