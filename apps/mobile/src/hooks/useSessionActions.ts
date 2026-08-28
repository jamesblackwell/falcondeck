import { useCallback, useRef, useState } from "react";

import {
  approvalPolicyForProvider,
  buildOptimisticUserItem,
  generateUserItemId,
  HandoffIncompleteError,
  handoffDestinationSettings,
  handoffThread,
  type HandoffThreadApi,
  normalizeThreadDetail,
  normalizeThreadHandle,
  parseCompactThreadCommand,
  draftKeyFor,
  imageAttachmentSendBlockReason,
  composerSkillCatalog,
  normalizeSkillSummaries,
  selectedSkillsFromText,
  serviceTierForTurn,
  threadForSelection,
  THREAD_DETAIL_OLDER_PAGE_LIMIT,
  THREAD_DETAIL_TAIL_LIMIT,
  workspaceModels,
  workspaceAgentCapabilities,
} from "@falcondeck/client-core";
import type {
  AgentProvider,
  ConversationItem,
  InteractiveResponsePayload,
  LiveSkillCatalog,
  SkillSummary,
  ThreadDetail,
  ThreadHandle,
} from "@falcondeck/client-core";

import { isDemoSession } from "@/features/demo/demoRpc";
import { isRelayTransportError } from "@/lib/connection-copy";
import {
  triggerMessageAcceptedHaptic,
  triggerMessageFailedHaptic,
} from "@/lib/haptics";
import { useRelayStore, useSessionStore, useUIStore } from "@/store";

const RECENT_THREAD_PREFETCH_LIMIT = 5;
// Prefetch waits this long after the first snapshot before its first fetch:
// users open a thread right after launch, and the prefetch must not compete
// with (or queue ahead of) that foreground load.
const RECENT_THREAD_PREFETCH_INITIAL_DELAY_MS = 1_000;
// Foreground tail loads bump this counter for their duration. Prefetch polls
// it between fetches and stands down while one is in flight, so a background
// warm-up never delays the thread the user just opened.
let activeForegroundDetailLoads = 0;
const FOREGROUND_DETAIL_LOAD_POLL_MS = 200;

const waitForForegroundDetailLoads = async () => {
  while (activeForegroundDetailLoads > 0) {
    await new Promise((resolve) =>
      setTimeout(resolve, FOREGROUND_DETAIL_LOAD_POLL_MS),
    );
  }
};

// Lets React paint once before send-side payload work continues. Image
// attachments travel as base64 data URLs; encrypting and serialising those
// megabytes occupies the JS thread, and without this yield the composer's
// on-tap clear visibly lags the send by the length of that work.
const nextPaint = () =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });

function emptyDestinationDetail(handle: ThreadHandle): ThreadDetail {
  return {
    workspace: handle.workspace,
    thread: handle.thread,
    items: [],
    has_older: false,
    oldest_item_id: null,
    newest_item_id: null,
    is_partial: false,
  };
}

function demoThreadDetail(
  workspaceId: string,
  threadId: string,
): ThreadDetail | null {
  const session = useSessionStore.getState();
  const workspace = session.snapshot?.workspaces.find(
    (entry) => entry.id === workspaceId,
  );
  const thread = session.snapshot?.threads.find(
    (entry) => entry.id === threadId,
  );
  if (!workspace || !thread) return null;
  const items = session.threadItems[threadId] ?? [];
  const detail: ThreadDetail = {
    workspace,
    thread,
    items,
    has_older: false,
    oldest_item_id: items[0]?.id ?? null,
    newest_item_id: items.at(-1)?.id ?? null,
    is_partial: false,
  };
  session.setThreadDetail(detail);
  return detail;
}

function showHandoffDestination(handle: ThreadHandle) {
  const session = useSessionStore.getState();
  session.applyThreadHandle(handle);
  session.setThreadDetail(emptyDestinationDetail(handle));
  session.selectThread(handle.workspace.id, handle.thread.id);
}

export function useSessionActions() {
  const detailRequestVersion = useRef(0);
  const liveSkillsRef = useRef<LiveSkillCatalog | null>(null);
  const handoffPendingRef = useRef(false);
  const [handoffPending, setHandoffPending] = useState(false);
  const [handoffPendingThreadKey, setHandoffPendingThreadKey] = useState<
    string | null
  >(null);

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

  /**
   * `override` sends a prompt the user did not type — today, a chosen composer
   * suggestion. It carries no attachments and leaves the composer's own draft
   * alone, so choosing a suggestion never eats work in progress.
   */
  const submitTurn = useCallback(async (override?: {
    text: string
    resumeInterrupted?: boolean
  }) => {
    const relay = useRelayStore.getState();
    const session = useSessionStore.getState();
    const ui = useUIStore.getState();

    const workspace = session.snapshot?.workspaces.find(
      (w) => w.id === session.selectedWorkspaceId,
    );
    const submittedDraft = override?.text ?? ui.draft;
    const submittedAttachments = override ? [] : ui.attachments;
    const submittedKey = ui.conversationKey;
    if (
      !workspace ||
      (!override?.resumeInterrupted &&
        !submittedDraft.trim() &&
        submittedAttachments.length === 0)
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
    const compactCommand = override
      ? null
      : parseCompactThreadCommand(submittedDraft);
    if (compactCommand) {
      if (!activeThread) {
        relay._setError("Start a conversation before compacting it.");
        return;
      }
      if (submittedAttachments.length > 0) {
        relay._setError("Remove attachments before compacting.");
        return;
      }
      if (
        activeThread.status === "running" ||
        activeThread.status === "waiting_for_input"
      ) {
        relay._setError("Wait for the current turn to finish before compacting.");
        return;
      }
      ui.setIsSubmitting(true, submittedKey);
      try {
        await relay._callRpc(
          "thread.compact",
          {
            workspace_id: workspace.id,
            thread_id: activeThread.id,
            instructions: compactCommand.instructions,
          },
          { requestIdPrefix: "mobile-compact" },
        );
        ui.setComposerForConversation(submittedKey, "", []);
        relay._setError(null);
      } catch (error) {
        if (!isRelayTransportError(error)) {
          relay._setError(
            error instanceof Error
              ? error.message
              : "Failed to compact context",
          );
        }
      } finally {
        ui.setIsSubmitting(false, submittedKey);
      }
      return;
    }
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
      composerSkillCatalog(liveSkillsRef.current, workspace, provider),
    );

    ui.setIsSubmitting(true, submittedKey);
    // Empty the composer in the same tick as the tap. The optimistic copy goes
    // into the transcript below, so text left in the input for the length of a
    // relay round trip reads as the message having been typed twice. The
    // submitted text lives in the in-flight record until the turn settles, so a
    // failure — or a process death mid-request — still gives it back.
    // An override never touched the composer, so there is nothing to empty and
    // nothing to hand back on failure.
    if (!override) ui.beginSubmission(submittedKey, submittedDraft);

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
        if (!override) ui.moveSubmission(submittedKey, branchKey);
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
      if (!expectQueued && !override?.resumeInterrupted) {
        useSessionStore
          .getState()
          .upsertLocalThreadItem(activeThreadId, optimisticItem);
        ui.clearPendingNewThreadItem(userItemId);
      }
      // Paint the emptied composer before the (potentially multi-megabyte)
      // turn payload is encrypted and serialised below.
      await nextPaint();
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
          resume_interrupted: Boolean(override?.resumeInterrupted),
        },
        { requestIdPrefix: "mobile-turn" },
      );
      triggerMessageAcceptedHaptic();
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
      if (!override) {
        ui.restoreFailedSubmission(
          restoreKey,
          submittedDraft,
          submittedAttachments,
        );
      }
      if (!isRelayTransportError(e)) {
        relay._setError(
          e instanceof Error ? e.message : "Failed to send message",
        );
      }
      triggerMessageFailedHaptic();
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
        if (!isRelayTransportError(error)) {
          relay._setError(error.message);
        }
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
      // The demo workspace has no daemon to page against: its transcripts are
      // whatever is already cached locally, and there is never anything older.
      if (isDemoSession(relay.sessionId)) {
        if (options?.older) return null;
        return demoThreadDetail(workspaceId, threadId);
      }
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

      const trackForegroundLoad = !options?.older;
      if (trackForegroundLoad) {
        activeForegroundDetailLoads += 1;
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
        if (!options?.older) {
          useSessionStore.getState().setThreadDetailError(threadId, null);
        }
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
          if (!isRelayTransportError(e)) {
            relay._setError("Couldn't load older messages. Try again.");
          }
        } else {
          // A tail-load failure on an uncached thread must not read as an
          // empty conversation; record it so the transcript shows an explicit
          // sync error with a retry instead of "No messages yet".
          console.warn("Failed to refresh thread detail", e);
          useSessionStore
            .getState()
            .setThreadDetailError(
              threadId,
              "Couldn't sync this conversation. Check your connection and try again.",
            );
        }
        return null;
      } finally {
        if (trackForegroundLoad) {
          activeForegroundDetailLoads -= 1;
        }
      }
    },
    [],
  );

  /**
   * Background warm-up of the most recently updated threads so switching to
   * them from the sidebar is instant. Only threads with no locally cached
   * items are fetched (the offline cache and the live event stream already
   * cover the rest), serially, to stay gentle on a flaky mobile link.
   */
  const prefetchRecentThreadDetails = useCallback(async () => {
    const relay = useRelayStore.getState();
    if (isDemoSession(relay.sessionId)) return;
    if (!relay._getSessionCrypto()) return;
    const session = useSessionStore.getState();
    if (!session.snapshot) return;

    const candidates = [...session.snapshot.threads]
      .filter((thread) => !thread.is_archived)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      .filter(
        (thread) =>
          thread.id !== session.selectedThreadId &&
          (session.threadItems[thread.id]?.length ?? 0) === 0,
      )
      .slice(0, RECENT_THREAD_PREFETCH_LIMIT);

    await new Promise((resolve) =>
      setTimeout(resolve, RECENT_THREAD_PREFETCH_INITIAL_DELAY_MS),
    );

    for (const thread of candidates) {
      // Yield to any foreground load: prefetch must never queue ahead of the
      // thread the user just opened, on the wire or on the daemon.
      await waitForForegroundDetailLoads();
      // Re-check each iteration: a foreground load, cache write, or thread
      // selection may have populated (or taken over) this thread meanwhile.
      const current = useSessionStore.getState();
      if (current.threadItems[thread.id]?.length) continue;
      if (current.selectedThreadId === thread.id) continue;
      try {
        const detail = normalizeThreadDetail(
          await relay._callRpc<ThreadDetail>(
            "thread.detail",
            {
              workspace_id: thread.workspace_id,
              thread_id: thread.id,
              mode: "tail",
              limit: THREAD_DETAIL_TAIL_LIMIT,
            },
            { requestIdPrefix: "mobile-prefetch" },
          ),
        );
        useSessionStore.getState().setThreadDetail(detail, {
          mergeMode: "refresh",
        });
      } catch {
        // Background best-effort: a failure here surfaces through the normal
        // foreground load (and its error state) if the user opens the thread.
      }
    }
  }, []);

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
              composerSkillCatalog(
                liveSkillsRef.current,
                sourceWorkspace,
                sourceThread.provider,
              ),
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
        if (!isRelayTransportError(error)) {
          relay._setError(error.message);
        }
        throw error;
      } finally {
        ui.setIsSubmitting(false, pendingConversationKey);
      }
    },
    [branchFromMessage],
  );

  const handoffToProvider = useCallback(async (provider: AgentProvider) => {
    const relay = useRelayStore.getState();
    const session = useSessionStore.getState();
    const ui = useUIStore.getState();
    const workspace = session.snapshot?.workspaces.find(
      (entry) => entry.id === session.selectedWorkspaceId,
    );
    const thread = threadForSelection(
      session.snapshot?.threads ?? [],
      session.selectedWorkspaceId,
      session.selectedThreadId,
    );
    if (!workspace || !thread || provider === thread.provider) return;
    if (handoffPendingRef.current) return;
    handoffPendingRef.current = true;
    setHandoffPending(true);

    const api: HandoffThreadApi = {
      async startThread(payload) {
        return normalizeThreadHandle(
          await relay._callRpc<ThreadHandle>("thread.start", payload, {
            requestIdPrefix: "mobile-handoff",
          }),
        );
      },
      async updateThread(payload) {
        return normalizeThreadHandle(
          await relay._callRpc<ThreadHandle>("thread.update", payload, {
            requestIdPrefix: "mobile-handoff",
          }),
        );
      },
      async sendTurn(payload) {
        const result = await relay._callRpc<{
          ok: boolean;
          message?: string | null;
        }>("turn.start", payload, { requestIdPrefix: "mobile-handoff-turn" });
        return result ?? { ok: true };
      },
      async threadDetail(workspaceId, threadId, request) {
        return normalizeThreadDetail(
          await relay._callRpc<ThreadDetail>(
            "thread.detail",
            {
              workspace_id: workspaceId,
              thread_id: threadId,
              ...request,
            },
            { requestIdPrefix: "mobile-handoff-detail" },
          ),
        );
      },
    };

    const destination = handoffDestinationSettings(
      workspace,
      provider,
      ui.persistedComposerSelections,
    );

    try {
      await handoffThread(
        api,
        {
          workspace,
          thread,
          provider,
          ...destination,
        },
        {
          onDestinationReady: (handle) => {
            showHandoffDestination(handle);
            setHandoffPendingThreadKey(
              draftKeyFor(handle.workspace.id, handle.thread.id),
            );
          },
        },
      );
      relay._setError(null);
    } catch (error) {
      if (error instanceof HandoffIncompleteError) {
        showHandoffDestination(error.handle);
        if (error.detail) {
          useSessionStore.getState().setThreadDetail(error.detail);
        }
        if (!error.turnStarted) {
          useUIStore.getState().setComposerForConversation(
            draftKeyFor(error.handle.workspace.id, error.handle.thread.id),
            error.prompt,
            [],
          );
        }
        if (!isRelayTransportError(error)) {
          relay._setError(
            error.turnStarted
              ? "FalconDeck lost confirmation after starting the handoff turn. Check the linked thread before retrying."
              : "The handoff turn did not start. Its prompt is ready in the composer to resend.",
          );
        }
        return;
      }
      if (!isRelayTransportError(error)) {
        relay._setError(
          error instanceof Error ? error.message : "Failed to create handoff",
        );
      }
    } finally {
      handoffPendingRef.current = false;
      setHandoffPending(false);
      setHandoffPendingThreadKey(null);
    }
  }, []);

  const loadWorkspaceSkills = useCallback(async (provider: AgentProvider) => {
    const relay = useRelayStore.getState();
    const session = useSessionStore.getState();
    const workspace = session.snapshot?.workspaces.find(
      (entry) => entry.id === session.selectedWorkspaceId,
    );
    if (!workspace) return [];
    try {
      const payload = await relay._callRpc<{ skills?: SkillSummary[] }>(
        "workspace.skills",
        {
          workspace_id: workspace.id,
          provider,
        },
        { requestIdPrefix: "mobile-skills" },
      );
      const skills = normalizeSkillSummaries(payload.skills);
      liveSkillsRef.current = {
        workspaceId: workspace.id,
        provider,
        skills,
      };
      return skills;
    } catch {
      return workspace.skills ?? [];
    }
  }, []);

  return {
    startThread,
    submitTurn,
    loadWorkspaceSkills,
    respondApproval,
    respondInteractive,
    loadThreadDetail,
    prefetchRecentThreadDetails,
    retryResponse,
    handoffToProvider,
    handoffPending,
    handoffPendingThreadKey,
  };
}
