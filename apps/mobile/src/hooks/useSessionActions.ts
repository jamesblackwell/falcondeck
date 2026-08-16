import { useCallback, useRef } from "react";

import {
  approvalPolicyForProvider,
  buildOptimisticUserItem,
  generateUserItemId,
  normalizeThreadDetail,
  normalizeThreadHandle,
  draftKeyFor,
  imageAttachmentSendBlockReason,
  selectedSkillsFromText,
  serviceTierForTurn,
  threadForSelection,
  THREAD_DETAIL_OLDER_PAGE_LIMIT,
  THREAD_DETAIL_TAIL_LIMIT,
  workspaceModels,
  workspaceAgentCapabilities,
} from "@falcondeck/client-core";
import type {
  ConversationItem,
  InteractiveResponsePayload,
  ThreadDetail,
  ThreadHandle,
} from "@falcondeck/client-core";

import { useRelayStore, useSessionStore, useUIStore } from "@/store";

export function useSessionActions() {
  const detailRequestVersion = useRef(0);

  const startThread = useCallback(async () => {
    const relay = useRelayStore.getState();
    const session = useSessionStore.getState();
    const ui = useUIStore.getState();
    const workspace = session.snapshot?.workspaces.find(
      (entry) => entry.id === session.selectedWorkspaceId,
    );
    if (!workspace) throw new Error("Select a project first");
    const provider =
      ui.selectedProvider ?? workspace.default_provider ?? "codex";
    const conversationKey = ui.conversationKey;
    const handle = normalizeThreadHandle(
      await relay._callRpc<ThreadHandle>(
        "thread.start",
        {
          workspace_id: workspace.id,
          provider,
          model_id: ui.selectedModel,
          approval_policy: approvalPolicyForProvider(
            provider,
            ui.selectedPermissionMode,
          ),
          permission_mode: ui.selectedPermissionMode,
          sandbox_mode: ui.selectedSandboxMode,
        },
        { requestIdPrefix: "mobile-thread" },
      ),
    );
    useSessionStore.getState().applyThreadHandle(handle);
    if (useUIStore.getState().conversationKey === conversationKey) {
      useSessionStore
        .getState()
        .selectThread(handle.workspace.id, handle.thread.id);
    }
    return handle;
  }, []);

  const submitTurn = useCallback(async () => {
    const relay = useRelayStore.getState();
    const session = useSessionStore.getState();
    const ui = useUIStore.getState();

    const workspace = session.snapshot?.workspaces.find(
      (w) => w.id === session.selectedWorkspaceId,
    );
    const submittedDraft = ui.draft;
    const submittedAttachments = ui.attachments;
    const submittedKey = ui.conversationKey;
    if (
      !workspace ||
      (!submittedDraft.trim() && submittedAttachments.length === 0)
    )
      return;
    const activeThread = threadForSelection(
      session.snapshot?.threads ?? [],
      session.selectedWorkspaceId,
      session.selectedThreadId,
    );
    const provider =
      activeThread?.provider ??
      ui.selectedProvider ??
      workspace.default_provider ??
      "codex";
    const imageBlockReason = imageAttachmentSendBlockReason(
      workspaceAgentCapabilities(workspace, provider),
      submittedAttachments.length,
    );
    if (imageBlockReason) {
      relay._setError(imageBlockReason);
      return;
    }
    const submittedSkills = selectedSkillsFromText(
      submittedDraft,
      workspace.skills ?? [],
    );

    ui.setIsSubmitting(true, submittedKey);
    // Empty the composer in the same tick as the tap. The optimistic copy goes
    // into the transcript below, so text left in the input for the length of a
    // relay round trip reads as the message having been typed twice. The
    // submitted text lives in the in-flight record until the turn settles, so a
    // failure — or a process death mid-request — still gives it back.
    ui.beginSubmission(submittedKey, submittedDraft);

    // Fresh per attempt: a retried send must not reuse an id the daemon may
    // already have committed a user item under.
    const userItemId = generateUserItemId();
    const inputs = [
      ...(submittedDraft.trim()
        ? [{ type: "text" as const, text: submittedDraft }]
        : []),
      ...submittedAttachments,
    ];
    const optimisticItem = buildOptimisticUserItem(
      userItemId,
      inputs,
      new Date().toISOString(),
    );
    let activeThreadId = session.selectedThreadId;
    let pendingConversationKey = submittedKey;
    if (!activeThreadId) {
      ui.setPendingNewThreadItem({
        conversationKey: submittedKey,
        item: optimisticItem,
      });
    }
    try {
      if (!activeThreadId) {
        const handle = await startThread();
        activeThreadId = handle.thread.id;
        const branchKey = draftKeyFor(handle.workspace.id, handle.thread.id);
        // The send now belongs to the thread the daemon created, so recovery
        // has to hand it back there rather than to the workspace's new-thread
        // composer, which the user may already be typing in again.
        ui.moveSubmission(submittedKey, branchKey);
        ui.setIsSubmitting(true, branchKey);
        ui.setIsSubmitting(false, pendingConversationKey);
        pendingConversationKey = branchKey;
      }

      // Tier-capable models get their tier stated on every turn — "fast off"
      // must reach the provider as an explicit standard-tier request, because
      // an omitted field means "keep the session's current tier".
      const models = workspaceModels(workspace, provider ?? "codex");
      const activeModel =
        models.find((model) => model.id === ui.selectedModel) ??
        models.find((model) => model.is_default) ??
        null;
      // Show the message in the transcript before the relay round-trip; the
      // daemon echoes it under the same id, replacing this copy in place. A
      // send to a busy thread lands in the queue UI instead, so skip it there.
      const expectQueued =
        activeThread?.status === "running" ||
        activeThread?.status === "waiting_for_input";
      if (!expectQueued) {
        useSessionStore
          .getState()
          .upsertLocalThreadItem(activeThreadId, optimisticItem);
        ui.clearPendingNewThreadItem(userItemId);
      }
      const sendResponse = await relay._callRpc<{
        ok: boolean;
        message?: string | null;
      }>(
        "turn.start",
        {
          workspace_id: workspace.id,
          thread_id: activeThreadId,
          inputs,
          user_item_id: userItemId,
          selected_skills: submittedSkills,
          provider,
          model_id: ui.selectedModel,
          reasoning_effort: ui.selectedEffort,
          approval_policy: approvalPolicyForProvider(
            provider,
            ui.selectedPermissionMode,
          ),
          service_tier: serviceTierForTurn(ui.selectedServiceTier, activeModel),
          permission_mode: ui.selectedPermissionMode,
          sandbox_mode: ui.selectedSandboxMode,
        },
        { requestIdPrefix: "mobile-turn" },
      );
      // The thread turned busy between our status check and the daemon's:
      // the send was queued, so the optimistic transcript copy comes out.
      if (sendResponse?.message === "queued") {
        useSessionStore
          .getState()
          .removeLocalThreadItem(activeThreadId, userItemId);
      }
      // Accepted (or queued): the composer is already empty, and the recovery
      // copy is no longer needed.
      ui.endSubmission(pendingConversationKey);
      relay._setError(null);
    } catch (e) {
      const restoreKey = activeThreadId
        ? draftKeyFor(workspace.id, activeThreadId)
        : submittedKey;
      // The message never reached the daemon; drop the optimistic copy and
      // put the text back into the composer.
      if (activeThreadId) {
        useSessionStore
          .getState()
          .removeLocalThreadItem(activeThreadId, userItemId);
      }
      ui.clearPendingNewThreadItem(userItemId);
      ui.restoreFailedSubmission(
        restoreKey,
        submittedDraft,
        submittedAttachments,
      );
      relay._setError(
        e instanceof Error ? e.message : "Failed to send message",
      );
    } finally {
      ui.clearPendingNewThreadItem(userItemId);
      ui.endSubmission(submittedKey);
      ui.endSubmission(pendingConversationKey);
      ui.setIsSubmitting(false, pendingConversationKey);
    }
  }, [startThread]);

  const respondInteractive = useCallback(
    async (
      workspaceId: string,
      requestId: string,
      response: InteractiveResponsePayload,
    ) => {
      const relay = useRelayStore.getState();
      try {
        await relay._callRpc(
          "interactive.respond",
          {
            workspace_id: workspaceId,
            request_id: requestId,
            response,
          },
          { requestIdPrefix: "mobile-interactive" },
        );
        relay._setError(null);
      } catch (e) {
        const error =
          e instanceof Error ? e : new Error("Interactive response failed");
        relay._setError(error.message);
        throw error;
      }
    },
    [],
  );

  const respondApproval = useCallback(
    async (requestId: string, decision: "allow" | "deny") => {
      const session = useSessionStore.getState();
      // The request names its own workspace; routing through the selected
      // workspace answered the wrong daemon whenever the user had switched
      // workspaces since the request arrived.
      const request = session.snapshot?.interactive_requests.find(
        (entry) => entry.request_id === requestId,
      );
      const workspaceId = request?.workspace_id ?? session.selectedWorkspaceId;
      if (!workspaceId) return;
      try {
        await respondInteractive(workspaceId, requestId, {
          kind: "approval",
          decision,
        });
      } catch (e) {
        // Legacy transcript action reports through the relay error banner. The
        // pinned interactive banner calls respondInteractive directly and can
        // additionally retain the error beside the user's selected answer.
        console.warn("[falcondeck] approval response failed", {
          requestId,
          decision,
          error: e,
        });
      }
    },
    [respondInteractive],
  );

  const loadThreadDetail = useCallback(
    async (
      workspaceId: string,
      threadId: string,
      options?: { older?: boolean },
    ) => {
      const relay = useRelayStore.getState();
      const session = useSessionStore.getState();
      const history = session.threadHistory[threadId];
      const beforeItemId = options?.older
        ? (history?.oldestItemId ?? null)
        : null;
      const requestVersion = options?.older
        ? detailRequestVersion.current
        : detailRequestVersion.current + 1;
      if (!options?.older) {
        detailRequestVersion.current = requestVersion;
      }

      if (options?.older && !beforeItemId) {
        return null;
      }

      try {
        const detail = normalizeThreadDetail(
          await relay._callRpc<ThreadDetail>(
            "thread.detail",
            options?.older
              ? {
                  workspace_id: workspaceId,
                  thread_id: threadId,
                  mode: "before",
                  before_item_id: beforeItemId,
                  limit: THREAD_DETAIL_OLDER_PAGE_LIMIT,
                }
              : {
                  workspace_id: workspaceId,
                  thread_id: threadId,
                  mode: "tail",
                  limit: THREAD_DETAIL_TAIL_LIMIT,
                },
            {
              requestIdPrefix: options?.older
                ? "mobile-detail-older"
                : "mobile-detail",
            },
          ),
        );

        const activeSession = useSessionStore.getState();
        const isStale =
          (!options?.older &&
            requestVersion !== detailRequestVersion.current) ||
          (options?.older &&
            activeSession.threadHistory[threadId]?.oldestItemId !==
              beforeItemId) ||
          activeSession.selectedThreadId !== threadId ||
          activeSession.selectedWorkspaceId !== workspaceId;

        if (isStale) {
          return null;
        }

        useSessionStore.getState().setThreadDetail(detail, {
          mergeMode: options?.older ? "prepend" : "refresh",
        });
        relay._setError(null);
        return detail;
      } catch (e) {
        const activeSession = useSessionStore.getState();
        const isStale =
          (!options?.older &&
            requestVersion !== detailRequestVersion.current) ||
          (options?.older &&
            activeSession.threadHistory[threadId]?.oldestItemId !==
              beforeItemId) ||
          activeSession.selectedThreadId !== threadId ||
          activeSession.selectedWorkspaceId !== workspaceId;
        if (isStale) {
          return null;
        }

        if (options?.older) {
          relay._setError("Couldn't load older messages. Try again.");
        } else {
          console.warn("Failed to refresh thread detail", e);
        }
        return null;
      }
    },
    [],
  );

  const branchFromMessage = useCallback(
    async (item: Extract<ConversationItem, { kind: "user_message" }>) => {
      const relay = useRelayStore.getState();
      const session = useSessionStore.getState();
      const workspace = session.snapshot?.workspaces.find(
        (entry) => entry.id === session.selectedWorkspaceId,
      );
      const thread = threadForSelection(
        session.snapshot?.threads ?? [],
        session.selectedWorkspaceId,
        session.selectedThreadId,
      );
      if (!workspace || !thread) return null;
      const sourceConversationKey = draftKeyFor(workspace.id, thread.id);

      const handle = normalizeThreadHandle(
        item.previous_turn_id
          ? await relay._callRpc<ThreadHandle>(
              "thread.fork",
              {
                workspace_id: workspace.id,
                thread_id: thread.id,
                last_turn_id: item.previous_turn_id,
              },
              { requestIdPrefix: "mobile-fork" },
            )
          : await relay._callRpc<ThreadHandle>(
              "thread.start",
              {
                workspace_id: workspace.id,
                provider: thread.provider,
                model_id: thread.agent.model_id,
                approval_policy: thread.agent.approval_policy,
                permission_mode: thread.agent.permission_mode,
                sandbox_mode: thread.agent.sandbox_mode,
                isolation: "project_folder",
              },
              { requestIdPrefix: "mobile-branch-thread" },
            ),
      );
      useSessionStore.getState().applyThreadHandle(handle);
      const activeSession = useSessionStore.getState();
      const adopted =
        activeSession.selectedWorkspaceId === workspace.id &&
        activeSession.selectedThreadId === thread.id;
      if (adopted) {
        activeSession.selectThread(handle.workspace.id, handle.thread.id);
      }
      return {
        adopted,
        handle,
        sourceConversationKey,
        sourceWorkspace: workspace,
        sourceThread: thread,
      };
    },
    [],
  );

  const retryResponse = useCallback(
    async (item: Extract<ConversationItem, { kind: "user_message" }>) => {
      const relay = useRelayStore.getState();
      const ui = useUIStore.getState();
      let branch: Awaited<ReturnType<typeof branchFromMessage>> = null;
      const sourceConversationKey = ui.conversationKey;
      let pendingConversationKey = sourceConversationKey;
      ui.setIsSubmitting(true, pendingConversationKey);
      try {
        branch = await branchFromMessage(item);
        if (!branch) return;
        const { handle, sourceThread, sourceWorkspace } = branch;
        const branchConversationKey = draftKeyFor(
          handle.workspace.id,
          handle.thread.id,
        );
        ui.setIsSubmitting(true, branchConversationKey);
        ui.setIsSubmitting(false, pendingConversationKey);
        pendingConversationKey = branchConversationKey;
        await relay._callRpc(
          "turn.start",
          {
            workspace_id: handle.workspace.id,
            thread_id: handle.thread.id,
            inputs: [
              ...(item.text.trim() ? [{ type: "text", text: item.text }] : []),
              ...item.attachments,
            ],
            selected_skills: selectedSkillsFromText(
              item.text,
              sourceWorkspace.skills ?? [],
            ),
            provider: sourceThread.provider,
            model_id: sourceThread.agent.model_id,
            reasoning_effort: sourceThread.agent.reasoning_effort,
            approval_policy: sourceThread.agent.approval_policy,
            service_tier: sourceThread.agent.service_tier,
            permission_mode: sourceThread.agent.permission_mode,
            sandbox_mode: sourceThread.agent.sandbox_mode,
          },
          { requestIdPrefix: "mobile-retry-turn" },
        );
        relay._setError(null);
      } catch (e) {
        if (branch) {
          ui.setComposerForConversation(
            draftKeyFor(branch.handle.workspace.id, branch.handle.thread.id),
            item.text,
            item.attachments,
          );
        }
        const error =
          e instanceof Error ? e : new Error("Failed to retry response");
        relay._setError(error.message);
        throw error;
      } finally {
        ui.setIsSubmitting(false, pendingConversationKey);
      }
    },
    [branchFromMessage],
  );

  return {
    startThread,
    submitTurn,
    respondApproval,
    respondInteractive,
    loadThreadDetail,
    retryResponse,
  };
}
