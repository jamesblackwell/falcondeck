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
import type { StartThreadPayload } from "./daemon-client";
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
  /**
   * Newest items the caller already holds for this thread. Supplying them
   * skips the opening `tail` read, which the daemon may widen well past the
   * requested limit to reach the last user message — on a slow uplink that
   * one response is the whole reason a handoff never starts.
   */
  seedItems?: readonly ConversationItem[] | null;
};

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

/**
 * How much source transcript a budgeted read pulls before it stops. Sized so
 * the whole read stays well inside the relay's request deadline on a slow
 * mobile uplink, while still filling most of the prompt's own character cap.
 */
export const HANDOFF_TRANSCRIPT_BUDGET_BYTES = 400_000;
/** Bounds the read when a thread's items are unusually small. */
const HANDOFF_TRANSCRIPT_MAX_PAGES = 12;

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
  options: {
    pageItems?: number | null;
    seedItems?: readonly ConversationItem[] | null;
  },
): Promise<{ items: ConversationItem[]; partial: boolean }> {
  const pageItems = options.pageItems;
  if (pageItems == null) {
    const detail = await api.threadDetail(workspaceId, threadId, {
      mode: "full",
    });
    return { items: detail.items, partial: false };
  }

  let items: ConversationItem[];
  let oldestItemId: string | null;
  let hasOlder: boolean;
  const seed = options.seedItems ?? [];
  if (seed.length > 0) {
    // Already on the device: costs nothing and avoids the widened tail read.
    items = [...seed];
    oldestItemId = items[0].id;
    hasOlder = true;
  } else {
    const tail = await api.threadDetail(workspaceId, threadId, {
      mode: "tail",
      limit: pageItems,
    });
    items = tail.items;
    oldestItemId = tail.oldest_item_id ?? items[0]?.id ?? null;
    hasOlder = tail.has_older;
  }
  let bytes = JSON.stringify(items).length;

  for (
    let page = 1;
    hasOlder &&
    oldestItemId != null &&
    bytes < HANDOFF_TRANSCRIPT_BUDGET_BYTES &&
    page < HANDOFF_TRANSCRIPT_MAX_PAGES;
    page += 1
  ) {
    // `before` is bounded by the requested count; `tail` is not.
    const older = await api.threadDetail(workspaceId, threadId, {
      mode: "before",
      before_item_id: oldestItemId,
      limit: pageItems,
    });
    hasOlder = older.has_older;
    if (older.items.length === 0) break;
    items = [...older.items, ...items];
    bytes += JSON.stringify(older.items).length;
    oldestItemId = older.oldest_item_id ?? older.items[0].id;
  }

  return { items, partial: hasOlder };
}

/**
 * Whether the daemon still holds a handoff transcript for this thread's
 * first message. Clients say so above the composer: the user picks a model
 * and types as normal, and the context rides along with that send.
 */
export function threadHasPendingHandoffContext(
  thread: Pick<ThreadSummary, "handoff_from"> | null | undefined,
): boolean {
  return Boolean(thread?.handoff_from?.context_pending);
}

/** Composer notice for a destination whose transcript is still waiting. */
export function pendingHandoffContextNotice(
  thread: Pick<ThreadSummary, "handoff_from"> | null | undefined,
  sourceTitle?: string | null,
): string | null {
  if (!threadHasPendingHandoffContext(thread)) return null;
  const source = sourceTitle?.trim();
  return source
    ? `The conversation from "${source}" is sent with your first message.`
    : "The previous conversation is sent with your first message.";
}

/**
 * Cross-provider "continue with another agent": a new thread on `provider`
 * that carries the source transcript. The daemon holds that transcript and
 * sends it ahead of the user's first message, so nothing is read by a model
 * until the user has chosen one and said what they want. The source is
 * never modified. Returns once the destination exists and is titled.
 */
export async function handoffThread(
  api: HandoffThreadApi,
  args: HandoffThreadArgs,
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
    seedItems: args.seedItems,
  });
  const context = buildHandoffPrompt({
    items: source.items,
    sourceTitle: thread.title,
    workspacePath: workspace.path,
    // A budgeted read starts mid-conversation. Say so rather than letting
    // the destination read a truncated history as the whole story.
    partial: source.partial,
  });

  const handle = await api.startThread({
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
    handoff_context: context,
  });
  try {
    return await api.updateThread({
      workspace_id: handle.workspace.id,
      thread_id: handle.thread.id,
      title: `${thread.title} · ${args.destinationLabel}`,
    });
  } catch {
    // The destination still exists under the auto-derived title.
    return handle;
  }
}
