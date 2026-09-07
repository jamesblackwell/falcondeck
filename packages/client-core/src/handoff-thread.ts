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
  ConversationItem,
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
  /**
   * Items per page when reading the source transcript. Omit on a local
   * transport to hand over the whole thread in one read. Clients on the
   * relay set it: a long thread is megabytes, and pulling all of it over a
   * slow uplink outlives the relay's request deadline, so the handoff never
   * starts. Pages are read newest-first until {@link HANDOFF_TRANSCRIPT_BUDGET_BYTES}.
   */
  transcriptPageItems?: number | null;
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
 * How much source transcript a budgeted read pulls before it stops. Sized so
 * the whole read stays well inside the relay's request deadline on a slow
 * mobile uplink, while still filling most of the prompt's own character cap.
 */
export const HANDOFF_TRANSCRIPT_BUDGET_BYTES = 400_000;
/** Bounds the read when a thread's items are unusually small. */
const HANDOFF_TRANSCRIPT_MAX_PAGES = 8;

/**
 * The newest slice of a thread that fits the byte budget. A single `full`
 * read is used when no page size is given (a local transport, where the
 * whole thread costs nothing); otherwise pages walk backwards from the tail
 * so no individual request is large enough to outlive the relay deadline.
 */
async function readHandoffTranscript(
  api: HandoffThreadApi,
  workspaceId: string,
  threadId: string,
  options: { pageItems?: number | null },
): Promise<{ items: ConversationItem[]; partial: boolean }> {
  const pageItems = options.pageItems;
  if (pageItems == null) {
    const detail = await api.threadDetail(workspaceId, threadId, {
      mode: "full",
    });
    return { items: detail.items, partial: false };
  }

  const tail = await api.threadDetail(workspaceId, threadId, {
    mode: "tail",
    limit: pageItems,
  });
  let items = tail.items;
  let oldestItemId = tail.oldest_item_id;
  let hasOlder = tail.has_older;
  let bytes = JSON.stringify(items).length;

  for (
    let page = 1;
    hasOlder &&
    oldestItemId != null &&
    bytes < HANDOFF_TRANSCRIPT_BUDGET_BYTES &&
    page < HANDOFF_TRANSCRIPT_MAX_PAGES;
    page += 1
  ) {
    const older = await api.threadDetail(workspaceId, threadId, {
      mode: "before",
      before_item_id: oldestItemId,
      limit: pageItems,
    });
    if (older.items.length === 0) break;
    items = [...older.items, ...items];
    bytes += JSON.stringify(older.items).length;
    oldestItemId = older.oldest_item_id;
    hasOlder = older.has_older;
  }

  return { items, partial: hasOlder };
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

  // Read the source before creating anything, so failed source hydration
  // cannot leave a destination thread behind.
  const source = await readHandoffTranscript(api, workspace.id, thread.id, {
    pageItems: args.transcriptPageItems,
  });
  const prompt = buildHandoffPrompt({
    items: source.items,
    sourceTitle: thread.title,
    workspacePath: workspace.path,
    // A budgeted read starts mid-conversation. Say so rather than letting
    // the destination read a truncated history as the whole story.
    partial: source.partial,
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
