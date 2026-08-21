import { buildForkPrompt } from "./handoff";
import type {
  ForkThreadPayload,
  SendTurnPayload,
  StartThreadPayload,
} from "./daemon-client";
import type {
  ThreadDetail,
  ThreadDetailRequest,
  ThreadHandle,
  ThreadSummary,
  UpdateThreadPayload,
  WorkspaceSummary,
} from "./types";

/**
 * The subset of `DaemonApiClient` "Fork thread" needs. Kept narrow so
 * callers can pass a plain object in tests without a full client.
 */
export interface ForkThreadApi {
  forkThread(payload: ForkThreadPayload): Promise<ThreadHandle>;
  startThread(payload: StartThreadPayload): Promise<ThreadHandle>;
  updateThread(payload: UpdateThreadPayload): Promise<ThreadHandle>;
  sendTurn(
    payload: SendTurnPayload,
  ): Promise<{ ok: boolean; message?: string | null }>;
  threadDetail(
    workspaceId: string,
    threadId: string,
    request?: Omit<ThreadDetailRequest, "workspace_id" | "thread_id">,
  ): Promise<ThreadDetail>;
}

/**
 * Whether the thread's provider can branch its history at a turn boundary
 * without replaying a transcript (see `AgentCapabilitySummary.supports_forking`,
 * Codex's `thread/fork` app-server RPC today). False for every provider that
 * needs the same-provider-handoff fallback in `forkThread`.
 */
export function threadSupportsNativeFork(
  thread: Pick<ThreadSummary, "provider">,
  workspace: Pick<WorkspaceSummary, "agents">,
): boolean {
  return Boolean(
    workspace.agents.find((agent) => agent.provider === thread.provider)
      ?.capabilities?.supports_forking,
  );
}

/**
 * "Fork thread": continue a conversation in a fresh, independent thread,
 * leaving the source untouched. Two mechanisms, one return shape:
 *
 * - Native fork (Codex today): the provider's own `thread/fork` branches the
 *   session at its last completed turn — a real session copy.
 * - Same-provider handoff (every other provider): a new thread on the same
 *   provider, seeded with the retained transcript as its first turn via the
 *   same bounded-transcript mechanism cross-provider handoff already uses.
 *
 * Callers never need to branch on provider; both paths return the new
 * thread's `ThreadHandle`.
 */
export async function forkThread(
  api: ForkThreadApi,
  args: { workspace: WorkspaceSummary; thread: ThreadSummary },
): Promise<ThreadHandle> {
  const { workspace, thread } = args;
  if (thread.variant) {
    throw new Error("Forking an isolated thread is not supported yet.");
  }

  if (threadSupportsNativeFork(thread, workspace) && thread.latest_turn_id) {
    return api.forkThread({
      workspace_id: workspace.id,
      thread_id: thread.id,
      last_turn_id: thread.latest_turn_id,
    });
  }

  const detail = await api.threadDetail(workspace.id, thread.id, {
    mode: "full",
  });
  if (detail.items.length === 0) {
    throw new Error("Nothing to fork yet — send a message first.");
  }

  const prompt = buildForkPrompt({
    items: detail.items,
    sourceTitle: thread.title,
    workspacePath: workspace.path,
  });
  const started = await api.startThread({
    workspace_id: workspace.id,
    provider: thread.provider,
    model_id: thread.agent.model_id,
    collaboration_mode_id: thread.agent.collaboration_mode_id,
    approval_policy: thread.agent.approval_policy,
    permission_mode: thread.agent.permission_mode,
    sandbox_mode: thread.agent.sandbox_mode,
    isolation: "project_folder",
    handoff_from: { thread_id: thread.id, provider: thread.provider },
  });
  // The seed turn below is the transcript dump, not something a user typed;
  // left alone, title auto-derivation would pick its opening line as the
  // thread's name. Set a real title first, mirroring the cross-provider
  // handoff flow's own `${title} · ${provider}` rename.
  const handle = await api.updateThread({
    workspace_id: started.workspace.id,
    thread_id: started.thread.id,
    title: `${thread.title} (fork)`,
  });
  await api.sendTurn({
    workspace_id: handle.workspace.id,
    thread_id: handle.thread.id,
    inputs: [{ type: "text", text: prompt }],
    provider: handle.thread.provider,
    model_id: handle.thread.agent.model_id,
    reasoning_effort: handle.thread.agent.reasoning_effort,
    approval_policy: handle.thread.agent.approval_policy,
    service_tier: handle.thread.agent.service_tier,
    permission_mode: handle.thread.agent.permission_mode,
    sandbox_mode: handle.thread.agent.sandbox_mode,
  });
  return handle;
}
