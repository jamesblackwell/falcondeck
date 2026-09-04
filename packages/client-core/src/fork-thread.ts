import { buildForkPrompt } from "./handoff";
import {
  handoffDestinationSettings,
  handoffThread,
  type HandoffThreadApi,
} from "./handoff-thread";
import type { PersistedComposerState } from "./composer-persistence";
import type { ForkThreadPayload } from "./daemon-client";
import type {
  AgentProvider,
  ThreadHandle,
  ThreadSummary,
  WorkspaceSummary,
} from "./types";

/**
 * The subset of `DaemonApiClient` "Fork thread" needs. Kept narrow so
 * callers can pass a plain object in tests without a full client.
 */
export interface ForkThreadApi extends HandoffThreadApi {
  forkThread(payload: ForkThreadPayload): Promise<ThreadHandle>;
}

export type ForkThreadArgs = {
  workspace: WorkspaceSummary;
  thread: ThreadSummary;
  /**
   * Harness the fork runs on. Defaults to the source thread's own provider;
   * any other value forks across harnesses via the cross-provider handoff.
   */
  provider?: AgentProvider;
  /** Remembered composer pickers, used to settle a cross-harness destination. */
  composer?: PersistedComposerState | null;
};

export type ForkThreadOptions = {
  /**
   * Fires once the new thread exists and is titled, before its seed turn is
   * sent, so the UI can switch to it instead of waiting on a slow first turn.
   * Never fires for a native fork, which returns its thread in one call.
   */
  onDestinationReady?: (handle: ThreadHandle) => void;
};

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
 * Why "Fork thread" cannot run on `provider` right now, or null when it can.
 * An isolated thread has a checkout of its own that a same-harness fork would
 * have to share; forking it onto another harness is a plain handoff, which
 * runs in the project folder and is allowed.
 */
export function forkBlockedReason(
  thread: Pick<ThreadSummary, "provider" | "variant">,
  provider?: AgentProvider,
): string | null {
  if (thread.variant && (provider ?? thread.provider) === thread.provider) {
    return "Forking an isolated thread onto the same harness is not supported yet.";
  }
  return null;
}

/**
 * "Fork thread": continue a conversation in a fresh, independent thread,
 * leaving the source untouched. Three mechanisms, one return shape:
 *
 * - Native fork (Codex today): the provider's own `thread/fork` branches the
 *   session at its last completed turn — a real session copy.
 * - Same-provider handoff (every other provider): a new thread on the same
 *   provider, seeded with the retained transcript as its first turn via the
 *   same bounded-transcript mechanism cross-provider handoff already uses.
 * - Cross-harness fork (`provider` differs from the thread's): the
 *   cross-provider handoff, which seeds the destination agent with the
 *   transcript and this workspace's remembered pickers for that harness.
 *
 * Callers never need to branch on provider; all three paths return the new
 * thread's `ThreadHandle`.
 */
export async function forkThread(
  api: ForkThreadApi,
  args: ForkThreadArgs,
  options?: ForkThreadOptions,
): Promise<ThreadHandle> {
  const { workspace, thread } = args;
  const provider = args.provider ?? thread.provider;
  const blocked = forkBlockedReason(thread, provider);
  if (blocked) throw new Error(blocked);

  if (provider !== thread.provider) {
    return handoffThread(
      api,
      {
        workspace,
        thread,
        provider,
        ...handoffDestinationSettings(workspace, provider, args.composer),
      },
      options,
    );
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
  options?.onDestinationReady?.(handle);
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
