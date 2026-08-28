import {
  approvalPolicyForProvider,
  workspaceAgentCapabilities,
  workspaceModels,
  workspaceProviderLabel,
} from "./collaboration";
import {
  composerSelectionFor,
  resolvePersistedMode,
  resolvePermissionMode,
  type PersistedComposerState,
} from "./composer-persistence";
import { buildHandoffPrompt } from "./handoff";
import type {
  SendTurnPayload,
  StartThreadPayload,
} from "./daemon-client";
import type {
  AgentProvider,
  ThreadDetail,
  ThreadDetailRequest,
  ThreadHandle,
  ThreadSummary,
  UpdateThreadPayload,
  WorkspaceSummary,
} from "./types";

/**
 * The subset of `DaemonApiClient` cross-provider handoff needs. Narrow so
 * callers can pass a plain object in tests without a full client.
 */
export interface HandoffThreadApi {
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

export type HandoffThreadArgs = {
  workspace: WorkspaceSummary;
  thread: ThreadSummary;
  provider: AgentProvider;
  /** Display name used in the destination title (`Fix login · Claude`). */
  destinationLabel: string;
  modelId: string | null;
  permissionMode: string | null;
  sandboxMode: string | null;
  approvalPolicy: string;
};

/**
 * The destination thread exists, but FalconDeck lost confirmation that the
 * seed turn started. Callers should show the linked thread and, when
 * `turnStarted` is false, put `prompt` in the composer so the user can resend.
 */
export class HandoffIncompleteError extends Error {
  readonly handle: ThreadHandle;
  readonly prompt: string;
  readonly turnStarted: boolean;
  readonly detail: ThreadDetail | null;

  constructor(args: {
    handle: ThreadHandle;
    prompt: string;
    turnStarted: boolean;
    detail?: ThreadDetail | null;
    message?: string;
    cause?: unknown;
  }) {
    const message =
      args.message ??
      (args.cause instanceof Error
        ? args.cause.message
        : "Failed to start the handoff turn");
    super(message);
    this.name = "HandoffIncompleteError";
    this.handle = args.handle;
    this.prompt = args.prompt;
    this.turnStarted = args.turnStarted;
    this.detail = args.detail ?? null;
  }
}

/**
 * Why a cross-provider handoff cannot start right now. `null` means the
 * destination list can be offered. The only UI gate is an in-flight create so
 * double-taps do not spawn two destinations. Running and isolated sources are
 * allowed: a handoff snapshots the transcript as it stands and never mutates
 * the source — the case that matters when a session is rate-limited or stuck.
 */
export function handoffBlockedReason(
  _thread: Pick<ThreadSummary, "status" | "variant"> | null | undefined,
  options?: { pending?: boolean },
): string | null {
  if (options?.pending) return "Creating the linked handoff thread…";
  return null;
}

/**
 * Destination composer settings for a cross-provider handoff. Uses the
 * remembered pickers for `provider` in this workspace, falling back to that
 * agent's advertised defaults so desktop, remote-web, and mobile seed the
 * same first turn.
 */
export function handoffDestinationSettings(
  workspace: WorkspaceSummary,
  provider: AgentProvider,
  persisted: PersistedComposerState | null | undefined = null,
) {
  const preferred = composerSelectionFor(
    persisted ?? {},
    workspace.path,
    provider,
  );
  const capabilities = workspaceAgentCapabilities(workspace, provider);
  const models = workspaceModels(workspace, provider);
  const modelId =
    preferred?.modelId && models.some((model) => model.id === preferred.modelId)
      ? preferred.modelId
      : (models.find((model) => model.is_default)?.id ??
        models[0]?.id ??
        null);
  const permissionMode = resolvePermissionMode(
    preferred?.permissionMode,
    capabilities.permission_modes,
  );
  const sandboxMode = resolvePersistedMode(
    preferred?.sandboxMode,
    capabilities.sandbox_modes,
  );
  return {
    destinationLabel: workspaceProviderLabel(workspace, provider),
    modelId,
    permissionMode,
    sandboxMode,
    approvalPolicy: approvalPolicyForProvider(provider, permissionMode),
  };
}

function turnLooksStarted(detail: ThreadDetail | null): boolean {
  if (!detail) return false;
  return (
    detail.items.length > 0 ||
    detail.thread.status === "running" ||
    detail.thread.status === "waiting_for_input"
  );
}

/**
 * Cross-provider "continue with another agent": a new thread on `provider`,
 * seeded with the source transcript as its first turn. The source is never
 * modified. `onDestinationReady` fires after the destination exists (and is
 * titled) so the UI can switch to it before the potentially slow seed turn.
 */
export async function handoffThread(
  api: HandoffThreadApi,
  args: HandoffThreadArgs,
  options?: {
    onDestinationReady?: (handle: ThreadHandle) => void;
  },
): Promise<ThreadHandle> {
  const { workspace, thread, provider } = args;
  if (provider === thread.provider) {
    throw new Error("Choose a different agent to continue with.");
  }
  const blocked = handoffBlockedReason(thread);
  if (blocked) throw new Error(blocked);

  // Read the complete source before creating anything, so failed source
  // hydration cannot leave a destination thread behind.
  const sourceDetail = await api.threadDetail(workspace.id, thread.id, {
    mode: "full",
  });
  const prompt = buildHandoffPrompt({
    items: sourceDetail.items,
    sourceTitle: thread.title,
    workspacePath: workspace.path,
  });

  let handle = await api.startThread({
    workspace_id: workspace.id,
    provider,
    model_id: args.modelId,
    permission_mode: args.permissionMode,
    approval_policy: args.approvalPolicy,
    sandbox_mode: args.sandboxMode,
    isolation: "project_folder",
    handoff_from: {
      thread_id: thread.id,
      provider: thread.provider,
    },
  });
  try {
    handle = await api.updateThread({
      workspace_id: handle.workspace.id,
      thread_id: handle.thread.id,
      title: `${thread.title} · ${args.destinationLabel}`,
    });
  } catch {
    // The destination still exists under the auto-derived title. Keep going.
  }
  options?.onDestinationReady?.(handle);

  try {
    await api.sendTurn({
      workspace_id: handle.workspace.id,
      thread_id: handle.thread.id,
      provider,
      model_id: args.modelId,
      permission_mode: args.permissionMode,
      approval_policy: args.approvalPolicy,
      sandbox_mode: args.sandboxMode,
      inputs: [{ type: "text", text: prompt }],
    });
    return handle;
  } catch (cause) {
    const recovered = await api
      .threadDetail(handle.workspace.id, handle.thread.id, { mode: "full" })
      .catch(() => null);
    throw new HandoffIncompleteError({
      handle,
      prompt,
      turnStarted: turnLooksStarted(recovered),
      detail: recovered,
      cause,
    });
  }
}
