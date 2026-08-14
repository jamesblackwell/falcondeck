import type {
  ConversationItem,
  ContentLifecycle,
  EventEnvelope,
  FalconDeckPreferences,
  ImageInput,
  InteractiveRequest,
  InteractiveRequestResolution,
  InteractiveResponsePayload,
  ThreadDetail,
  ToolActivityKind,
  ToolDetailsMode,
  ToolLifecycle,
  TurnInputItem,
} from "./types";
import { normalizeEventEnvelope, normalizePreferences } from "./normalization";
import { summarizeMcpArtifacts } from "./provider-output";

/** Creates the receipt-safe outcome for a response without retaining answers. */
export function interactiveResolutionFromResponse(
  response: InteractiveResponsePayload,
  resolvedAt = new Date().toISOString(),
): InteractiveRequestResolution {
  if (response.kind === "question") {
    return { outcome: "answered", resolved_at: resolvedAt };
  }
  const outcome =
    response.decision === "allow"
      ? "allowed"
      : response.decision === "always_allow"
        ? "always_allowed"
        : "denied";
  return { outcome, resolved_at: resolvedAt };
}

/** Builds the actionable response queue consistently on every client.
 *
 * Daemon snapshots are newest-first while users must answer the oldest
 * blocking request first. Replayed identities keep their newest payload but
 * never create a second actionable card. The stable id tie-breaker keeps
 * reconnects deterministic when provider timestamps collide.
 */
export function orderedInteractiveRequestQueue(
  requests: readonly InteractiveRequest[],
): InteractiveRequest[] {
  const latestById = new Map<string, InteractiveRequest>();
  for (const request of requests) latestById.set(request.request_id, request);

  return [...latestById.values()].sort((left, right) => {
    const leftTime = Date.parse(left.created_at);
    const rightTime = Date.parse(right.created_at);
    const leftValid = Number.isFinite(leftTime);
    const rightValid = Number.isFinite(rightTime);
    if (leftValid && rightValid && leftTime !== rightTime)
      return leftTime - rightTime;
    if (leftValid !== rightValid) return leftValid ? -1 : 1;
    return left.request_id.localeCompare(right.request_id);
  });
}

/** Provider-authoritative approval choices with a conservative legacy fallback. */
export function interactiveApprovalDecisions(
  request: Pick<InteractiveRequest, "kind" | "approval_decisions">,
) {
  if (request.kind !== "approval") return [];
  return request.approval_decisions ?? ["allow", "deny"];
}

export type InteractiveRequestReceiptTone =
  "success" | "danger" | "warning" | "info" | "neutral";

export type InteractiveRequestEvidence = {
  summary: string;
  command: string | null;
  path: string | null;
  detail: string | null;
  questions: InteractiveRequest["questions"];
};

function interactiveRequestDetail(
  request: Pick<InteractiveRequest, "command" | "path" | "detail">,
) {
  const detail = request.detail?.trim();
  if (!detail) return null;
  if (detail === request.command?.trim() || detail === request.path?.trim())
    return null;
  if (!detail.startsWith("{") && !detail.startsWith("[")) return detail;

  try {
    const payload = JSON.parse(detail) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return null;
    const record = payload as Record<string, unknown>;
    for (const key of ["description", "reason", "message", "prompt"] as const) {
      const value = record[key];
      if (typeof value !== "string") continue;
      const summary = value.trim();
      if (
        summary &&
        summary !== request.command?.trim() &&
        summary !== request.path?.trim()
      )
        return summary;
    }
    return null;
  } catch {
    // Malformed provider text is still evidence; only valid transport JSON is
    // hidden when it has no useful human-facing summary.
    return detail;
  }
}

/** Exact, receipt-safe provider evidence shared by every client.
 * User answers are deliberately absent from InteractiveRequest and therefore
 * can never leak into resolved transcript receipts. */
export function interactiveRequestEvidencePresentation(
  request: Pick<
    InteractiveRequest,
    "command" | "path" | "detail" | "questions"
  >,
): InteractiveRequestEvidence {
  const command = request.command?.trim() || null;
  const rawPath = request.path?.trim() || null;
  const path = rawPath && !command?.includes(rawPath) ? rawPath : null;
  const detail = interactiveRequestDetail(request);
  const questions =
    request.questions?.filter(
      (question) => question.question.trim().length > 0,
    ) ?? [];
  const summary =
    command || path || detail || questions[0]?.question.trim() || "";
  return { summary, command, path, detail, questions };
}

/** User-facing receipt text and semantic tone for a terminal request outcome. */
export function interactiveRequestReceiptPresentation(
  request: Pick<InteractiveRequest, "kind" | "title">,
  resolution: InteractiveRequestResolution | null | undefined,
): { label: string; tone: InteractiveRequestReceiptTone } {
  const title =
    request.title.trim().replace(/\?$/, "") ||
    (request.kind === "question" ? "Question" : "Request");
  const approvalSubject = title.replace(/^(?:allow|approve)\s+/i, "");
  switch (resolution?.outcome) {
    case "allowed":
      return { label: `Allowed ${approvalSubject}`, tone: "success" };
    case "always_allowed":
      return { label: `Always allowed ${approvalSubject}`, tone: "success" };
    case "denied":
      return { label: `Denied ${approvalSubject}`, tone: "danger" };
    case "answered":
      return { label: `Answered: ${title}`, tone: "info" };
    case "expired":
      return { label: `Expired: ${title}`, tone: "warning" };
    case "cancelled":
      return { label: `Cancelled: ${title}`, tone: "warning" };
    default:
      return { label: `Resolved: ${title}`, tone: "neutral" };
  }
}

export function contentLifecycle(
  item: Pick<
    Extract<
      ConversationItem,
      {
        kind:
          | "assistant_message"
          | "reasoning"
          | "code_review"
          | "artifact"
          | "image"
          | "web_search"
          | "unsupported";
      }
    >,
    "lifecycle"
  >,
): ContentLifecycle {
  return item.lifecycle ?? "complete";
}

/** Provider-reported failure detail for an assistant message, unless the
 * message body already carries that text. A provider that cannot read an image
 * (for example) often echoes the same error as both the response prose and the
 * turn error; showing it again beneath "Response failed" would duplicate it. */
export function assistantFailureDetail(
  item: Extract<ConversationItem, { kind: "assistant_message" }>,
): string | null {
  const error = item.error?.trim();
  if (!error) return null;
  if (item.text.includes(error)) return null;
  return error;
}

export function contentLifecycleLabel(lifecycle: ContentLifecycle) {
  switch (lifecycle) {
    case "pending":
      return "Pending";
    case "streaming":
      return "Streaming";
    case "interrupted":
      return "Interrupted";
    case "error":
      return "Failed";
    default:
      return "Complete";
  }
}

export type ResponseCompletionTrackerState = {
  threadKey: string | null;
  wasBusy: boolean;
  awaitingCompletion: boolean;
  baselineAssistantId: string | null;
  activeAssistantId: string | null;
};

export type ResponseCompletionObservation = {
  threadKey: string | null;
  busy: boolean;
  /** True only when the enclosing turn is terminal and not blocked on input. */
  ready: boolean;
  items: ConversationItem[];
};

/** Tracks the exact final-answer item produced by one busy turn.
 *
 * Thread status and item lifecycle commonly arrive in separate store commits.
 * Retaining the active item and pre-turn baseline prevents both a missed late
 * completion and a failed send re-announcing an older completed answer. */
export function advanceResponseCompletionTracker(
  previous: ResponseCompletionTrackerState | null,
  observation: ResponseCompletionObservation,
): {
  state: ResponseCompletionTrackerState;
  completed: boolean;
} {
  let latestAssistant: Extract<
    ConversationItem,
    { kind: "assistant_message" }
  > | null = null;
  for (let index = observation.items.length - 1; index >= 0; index -= 1) {
    const candidate = observation.items[index];
    if (
      candidate?.kind === "assistant_message" &&
      candidate.phase !== "commentary"
    ) {
      latestAssistant = candidate;
      break;
    }
  }

  const lifecycle = latestAssistant ? contentLifecycle(latestAssistant) : null;
  const activeLifecycle = lifecycle === "pending" || lifecycle === "streaming";
  if (!previous || previous.threadKey !== observation.threadKey) {
    return {
      state: {
        threadKey: observation.threadKey,
        wasBusy: observation.busy,
        awaitingCompletion: observation.busy,
        baselineAssistantId: latestAssistant?.id ?? null,
        activeAssistantId: activeLifecycle
          ? (latestAssistant?.id ?? null)
          : null,
      },
      completed: false,
    };
  }

  let awaitingCompletion = previous.awaitingCompletion;
  let baselineAssistantId = previous.baselineAssistantId;
  let activeAssistantId = previous.activeAssistantId;

  if (!previous.wasBusy && observation.busy) {
    awaitingCompletion = true;
    baselineAssistantId = latestAssistant?.id ?? null;
    activeAssistantId = activeLifecycle ? (latestAssistant?.id ?? null) : null;
  } else if (activeLifecycle && latestAssistant) {
    activeAssistantId = latestAssistant.id;
  }

  let completed = false;
  if (latestAssistant && lifecycle && !activeLifecycle) {
    const belongsToCurrentResponse =
      activeAssistantId === latestAssistant.id ||
      (awaitingCompletion && latestAssistant.id !== baselineAssistantId);

    if (belongsToCurrentResponse && lifecycle === "complete") {
      // Content can settle before the provider turn does. Keep the exact item
      // armed until the enclosing turn reaches its authoritative idle state.
      if (observation.ready) {
        completed = true;
        awaitingCompletion = false;
        activeAssistantId = null;
      }
    } else if (belongsToCurrentResponse) {
      // Interrupted/error content is terminal but is not a successful response.
      awaitingCompletion = false;
      activeAssistantId = null;
    }
  }

  return {
    state: {
      threadKey: observation.threadKey,
      wasBusy: observation.busy,
      awaitingCompletion,
      baselineAssistantId,
      activeAssistantId,
    },
    completed,
  };
}

/** Human-readable label for an open-ended provider discriminator. */
export function providerOutputKindLabel(kind: string | null | undefined) {
  const normalized = kind?.trim() || "unknown";
  return normalized
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export type CodeReviewTone = "progress" | "success" | "warning" | "danger";

/** Shared copy for provider-authored code review lifecycle and scope. */
export function codeReviewPresentation(
  lifecycle: ContentLifecycle | null | undefined,
  subject: string | null | undefined,
): { label: string; detail: string; tone: CodeReviewTone } {
  const scope = subject?.trim();
  switch (lifecycle) {
    case "pending":
    case "streaming":
      return {
        label: scope ? `Reviewing ${scope}` : "Reviewing changes",
        detail: "Inspecting the requested code and preparing findings.",
        tone: "progress",
      };
    case "interrupted":
      return {
        label: "Code review interrupted",
        detail: scope
          ? `The review of ${scope} stopped before completion.`
          : "The review stopped before completion.",
        tone: "warning",
      };
    case "error":
      return {
        label: "Code review failed",
        detail: scope
          ? `The provider could not finish reviewing ${scope}.`
          : "The provider could not finish the review.",
        tone: "danger",
      };
    default:
      return {
        label: "Code review",
        detail: scope ? `Review of ${scope}` : "Review completed",
        tone: "success",
      };
  }
}

export type ContextCompactionTone =
  "neutral" | "progress" | "success" | "warning" | "danger";

/** Calm, provider-independent copy for the context compaction lifecycle receipt. */
export function contextCompactionPresentation(
  lifecycle: ToolLifecycle | null | undefined,
): { label: string; detail: string; tone: ContextCompactionTone } {
  switch (lifecycle) {
    case "queued":
      return {
        label: "Context compaction queued",
        detail: "Earlier conversation will be summarized for continuity.",
        tone: "neutral",
      };
    case "running":
      return {
        label: "Compacting context",
        detail: "Summarizing earlier conversation so this thread can continue.",
        tone: "progress",
      };
    case "succeeded":
      return {
        label: "Context compacted",
        detail: "Earlier conversation was summarized for continuity.",
        tone: "success",
      };
    case "failed":
      return {
        label: "Context compaction failed",
        detail: "The provider could not finish summarizing this thread.",
        tone: "danger",
      };
    case "interrupted":
    case "denied":
      return {
        label: "Context compaction stopped",
        detail: "The provider stopped before summarizing this thread.",
        tone: "warning",
      };
    default:
      return {
        label: "Context compaction",
        detail: "Earlier conversation may have been summarized for continuity.",
        tone: "neutral",
      };
  }
}

export type RetryableUserMessage = Extract<
  ConversationItem,
  { kind: "user_message" }
>;

/**
 * Associates terminal assistant answers with the user turn they can safely
 * regenerate. A steering message deliberately clears the candidate because it
 * has no standalone provider turn boundary and must never retry an earlier
 * prompt by accident.
 */
export function retrySourcesByAssistantId(items: ConversationItem[]) {
  const sources = new Map<string, RetryableUserMessage>();
  let source: RetryableUserMessage | null = null;

  for (const item of items) {
    if (item.kind === "user_message") {
      source = item.turn_id ? item : null;
      continue;
    }
    if (
      item.kind !== "assistant_message" ||
      item.phase === "commentary" ||
      !source
    )
      continue;
    sources.set(item.id, source);
  }

  return sources;
}

export function reuseRetrySourcesByAssistantId(
  previous: Map<string, RetryableUserMessage> | null | undefined,
  items: ConversationItem[],
) {
  const next = retrySourcesByAssistantId(items);
  if (!previous || previous.size !== next.size) return next;
  for (const [assistantId, source] of next) {
    if (previous.get(assistantId) !== source) return next;
  }
  return previous;
}

export function sortConversationItems(items: ConversationItem[]) {
  // Plain code-unit comparison: created_at values are uniform ISO-8601 strings
  // (same UTC offset and precision from the daemon), so lexicographic order is
  // chronological order and ICU collation is unnecessary on this hot path.
  return [...items].sort((left, right) =>
    left.created_at < right.created_at
      ? -1
      : left.created_at > right.created_at
        ? 1
        : 0,
  );
}

export function conversationItemsForSelection(
  selectedWorkspaceId: string | null,
  selectedThreadId: string | null,
  detail: ThreadDetail | null,
  fallbackItems: ConversationItem[] = [],
): ConversationItem[] {
  if (!selectedThreadId) {
    return [];
  }

  // Thread detail can briefly lag behind selection changes, so only trust it
  // when it still belongs to the active workspace/thread pair.
  if (
    detail &&
    detail.workspace.id === selectedWorkspaceId &&
    detail.thread.id === selectedThreadId
  ) {
    return detail.items;
  }

  return fallbackItems;
}

export type ThreadDetailMergeMode = "refresh" | "prepend";

export const THREAD_DETAIL_TAIL_LIMIT = 150;
export const THREAD_DETAIL_OLDER_PAGE_LIMIT = 100;

/** How long a refresh keeps an unacknowledged optimistic user message alive. */
const PENDING_USER_ITEM_TTL_MS = 5 * 60_000;

function conversationItemKey(item: ConversationItem) {
  return `${item.kind}:${item.id}`;
}

/**
 * Merges one daemon-owned history page without letting a stale cached tail
 * survive inside the authoritative overlap. `refresh` preserves only the
 * continuous older prefix before the first shared item; when there is no
 * overlap, the fresh tail wins rather than splicing unrelated histories.
 */
export function mergeThreadDetailPage(
  current: ThreadDetail | null | undefined,
  page: ThreadDetail,
  mode: ThreadDetailMergeMode,
): ThreadDetail {
  if (
    !current ||
    current.workspace.id !== page.workspace.id ||
    current.thread.id !== page.thread.id
  ) {
    return page;
  }

  let items: ConversationItem[];
  let hasOlder: boolean;

  if (mode === "prepend") {
    const pageKeys = new Set(page.items.map(conversationItemKey));
    items = [
      ...page.items,
      ...current.items.filter(
        (item) => !pageKeys.has(conversationItemKey(item)),
      ),
    ];
    hasOlder = page.has_older;
  } else {
    const currentIndexes = new Map(
      current.items.map(
        (item, index) => [conversationItemKey(item), index] as const,
      ),
    );
    let overlapIndex = -1;
    for (const item of page.items) {
      const index = currentIndexes.get(conversationItemKey(item));
      if (index !== undefined) {
        overlapIndex = index;
        break;
      }
    }

    if (overlapIndex === -1) {
      items = page.items;
      hasOlder = page.has_older;
    } else {
      items = [...current.items.slice(0, overlapIndex), ...page.items];
      hasOlder = overlapIndex > 0 ? current.has_older : page.has_older;
    }

    // An optimistic user message is client-local until the daemon echoes it;
    // a refresh fetched before that echo doesn't contain it and must not
    // swallow it. Duplicate-by-content echoes are folded by the upsert path.
    // The age cutoff stops a pending item whose removal was lost (crash
    // between failure and cleanup) from haunting the transcript forever.
    const pageKeys = new Set(items.map(conversationItemKey));
    const pendingTail = current.items.filter(
      (item) =>
        item.kind === "user_message" &&
        item.pending === true &&
        Date.now() - Date.parse(item.created_at) < PENDING_USER_ITEM_TTL_MS &&
        !pageKeys.has(conversationItemKey(item)) &&
        !items.some(
          (kept) => kept.kind === "user_message" && kept.text === item.text,
        ),
    );
    if (pendingTail.length > 0) {
      items = [...items, ...pendingTail];
    }
  }

  return {
    ...page,
    items,
    has_older: hasOlder,
    oldest_item_id: items[0]?.id ?? null,
    newest_item_id: items.at(-1)?.id ?? null,
    // A continuous merged window is partial exactly while the daemon says
    // more history remains before its oldest retained item.
    is_partial: hasOlder,
  };
}

/**
 * Id for a user message the client renders before the daemon acknowledges the
 * send. Same shape as daemon-minted ids (`user-` + 32 hex) so the daemon
 * accepts it and echoes the item under the same id.
 */
export function generateUserItemId(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return `user-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Local stand-in for the user message the daemon will create from these
 * inputs. Text assembly mirrors the daemon's `build_user_message_item` so the
 * echo replaces it without any visible change.
 */
export function buildOptimisticUserItem(
  id: string,
  inputs: TurnInputItem[],
  createdAt: string,
): ConversationItem {
  const textParts: string[] = [];
  const attachments: ImageInput[] = [];
  for (const input of inputs) {
    if (input.type === "text") {
      textParts.push(input.text);
    } else {
      attachments.push(input);
    }
  }
  return {
    kind: "user_message",
    id,
    text: textParts.join("\n\n"),
    attachments,
    created_at: createdAt,
    pending: true,
  };
}

/** Drops the optimistic user item with this id (failed or queued send). */
export function removeConversationItem(
  items: ConversationItem[],
  id: string,
): ConversationItem[] {
  const index = items.findIndex((item) => item.id === id);
  return index === -1
    ? items
    : [...items.slice(0, index), ...items.slice(index + 1)];
}

export function upsertConversationItem(
  items: ConversationItem[],
  next: ConversationItem,
): ConversationItem[] {
  const last = items.at(-1);
  if (!last) {
    return [next];
  }

  // Identity must be resolved before any timestamp-based fast path: the
  // Claude and ACP daemon paths re-emit whole items with a fresh created_at
  // on every update, so "newer timestamp" does not imply "new item". An
  // update that matches an existing item keeps that item's original
  // created_at anchor — an update may change content, never position, or
  // streaming items visibly jump around the transcript as they complete.
  const replaceAt = (index: number) => {
    const existing = items[index];
    const clone = items.slice();
    clone[index] =
      existing.created_at === next.created_at
        ? next
        : { ...next, created_at: existing.created_at };
    return clone;
  };

  // Streaming updates usually target the tail item; check it before scanning.
  if (last.id === next.id && last.kind === next.kind) {
    return replaceAt(items.length - 1);
  }

  const index = items.findIndex(
    (item) => item.id === next.id && item.kind === next.kind,
  );
  if (index !== -1) {
    return replaceAt(index);
  }

  // A daemon that predates client-supplied user item ids echoes the message
  // under its own id. Fold that echo into the optimistic copy by content so
  // the message doesn't render twice.
  if (next.kind === "user_message") {
    const pendingIndex = items.findIndex(
      (item) =>
        item.kind === "user_message" &&
        item.pending === true &&
        item.text === next.text,
    );
    if (pendingIndex !== -1) {
      return replaceAt(pendingIndex);
    }
  }

  if (next.created_at >= last.created_at) {
    return [...items, next];
  }
  return sortConversationItems([...items, next]);
}

type TextDeltaEvent = Extract<EventEnvelope["event"], { type: "text" }>;

function lifecycleAfterTextDelta(
  lifecycle: ContentLifecycle | null | undefined,
): ContentLifecycle {
  return lifecycle === "complete" ||
    lifecycle === "interrupted" ||
    lifecycle === "error"
    ? lifecycle
    : "streaming";
}

function applyTextDeltaToConversationItem(
  item: ConversationItem,
  event: TextDeltaEvent,
): ConversationItem {
  const start = event.start_offset;
  const end = event.end_offset;
  if (start == null || end == null || end !== start + event.delta.length) {
    return item;
  }

  const target = event.target ?? "assistant_text";
  let current: string;
  if (item.kind === "assistant_message" && target === "assistant_text") {
    current = item.text;
  } else if (item.kind === "reasoning" && target === "reasoning_summary") {
    current = item.summary ?? "";
  } else if (item.kind === "reasoning" && target === "reasoning_content") {
    current = item.content;
  } else if (item.kind === "tool_call" && target === "tool_output") {
    current = item.output ?? "";
  } else if (item.kind === "plan" && target === "plan_explanation") {
    current = item.plan.explanation ?? "";
  } else {
    return item;
  }

  // The delta is already present, including when a newer snapshot raced ahead
  // of replay. Do not allocate or make React render the item again.
  if (current.length >= end && current.slice(start, end) === event.delta) {
    return item;
  }
  if (current.length !== start) return item;

  if (item.kind === "assistant_message") {
    return {
      ...item,
      text: `${item.text}${event.delta}`,
      lifecycle: lifecycleAfterTextDelta(item.lifecycle),
    };
  }
  if (item.kind === "reasoning" && target === "reasoning_summary") {
    return {
      ...item,
      summary: `${item.summary ?? ""}${event.delta}`,
      lifecycle: lifecycleAfterTextDelta(item.lifecycle),
    };
  }
  if (item.kind === "reasoning") {
    return {
      ...item,
      content: `${item.content}${event.delta}`,
      lifecycle: lifecycleAfterTextDelta(item.lifecycle),
    };
  }
  if (item.kind === "tool_call") {
    const lifecycle = toolLifecycle(item);
    const terminal =
      lifecycle === "succeeded" ||
      lifecycle === "failed" ||
      lifecycle === "denied" ||
      lifecycle === "interrupted";
    return {
      ...item,
      output: `${item.output ?? ""}${event.delta}`,
      status: terminal ? item.status : "running",
      display: terminal
        ? item.display
        : { ...item.display, lifecycle: "running" },
    };
  }
  if (item.kind !== "plan") return item;
  return {
    ...item,
    plan: {
      ...item.plan,
      explanation: `${item.plan.explanation ?? ""}${event.delta}`,
    },
  };
}

function textDeltaItemKind(
  target: TextDeltaEvent["target"],
): ConversationItem["kind"] {
  if (target === "tool_output") return "tool_call";
  if (target === "plan_explanation") return "plan";
  if (target === "reasoning_summary" || target === "reasoning_content")
    return "reasoning";
  return "assistant_message";
}

/**
 * Applies an offset-checked text delta without duplicating content after relay
 * replay or a snapshot/event race. Offsets use UTF-16 so they match JavaScript
 * string indexing exactly. A gap or malformed event is ignored; the next full
 * thread snapshot remains the recovery source of truth.
 */
export function applyTextDeltaToConversationItems(
  items: ConversationItem[],
  event: TextDeltaEvent,
): ConversationItem[] {
  const target = event.target ?? "assistant_text";
  const kind = textDeltaItemKind(target);
  const index = items.findIndex(
    (item) => item.id === event.item_id && item.kind === kind,
  );
  if (index === -1) return items;

  const item = items[index];
  const nextItem = applyTextDeltaToConversationItem(item, event);
  if (nextItem === item) return items;

  const clone = items.slice();
  clone[index] = nextItem;
  return clone;
}

/**
 * Applies a display-frame batch while allocating the item array at most once
 * for text-only streaming. This keeps token bursts O(items + deltas), rather
 * than cloning a long transcript once per token.
 */
export function applyConversationEventsToItems(
  items: ConversationItem[],
  events: EventEnvelope[],
): ConversationItem[] {
  let next = items;
  let ownsArray = false;
  let indexByIdentity: Map<string, number> | null = null;

  const itemIndex = (id: string, kind: ConversationItem["kind"]) => {
    if (!indexByIdentity) {
      indexByIdentity = new Map(
        next.map(
          (item, index) => [`${item.kind}\u0000${item.id}`, index] as const,
        ),
      );
    }
    return indexByIdentity.get(`${kind}\u0000${id}`) ?? -1;
  };
  // Closure so the captured map keeps its declared nullable type; inline use
  // would be narrowed to null by straight-line flow analysis.
  const rememberAppendedIndex = (item: ConversationItem, index: number) => {
    indexByIdentity?.set(`${item.kind}\u0000${item.id}`, index);
  };

  for (const event of events) {
    const normalizedEvent = normalizeEventEnvelope(event);
    if (normalizedEvent.event.type === "text") {
      const textEvent = normalizedEvent.event;
      const index = itemIndex(
        textEvent.item_id,
        textDeltaItemKind(textEvent.target ?? "assistant_text"),
      );
      if (index === -1) continue;
      const currentItem = next[index];
      const nextItem = applyTextDeltaToConversationItem(currentItem, textEvent);
      if (nextItem === currentItem) continue;
      if (!ownsArray) {
        next = next.slice();
        ownsArray = true;
      }
      next[index] = nextItem;
      continue;
    }

    // Item events resolve identity through the shared map so a burst of
    // re-emitted items (Claude/ACP send the whole item per update) stays
    // O(items + events) instead of scanning the transcript per event.
    if (
      normalizedEvent.event.type === "conversation-item-added" ||
      normalizedEvent.event.type === "conversation-item-updated"
    ) {
      const item = normalizedEvent.event.item;
      const index = itemIndex(item.id, item.kind);
      if (!ownsArray) {
        next = next.slice();
        ownsArray = true;
      }
      if (index !== -1) {
        const existing = next[index];
        // Same anchor rule as upsertConversationItem: an update may change
        // content, never position.
        next[index] =
          existing.created_at === item.created_at
            ? item
            : { ...item, created_at: existing.created_at };
        continue;
      }
      const last = next.at(-1);
      if (!last || item.created_at >= last.created_at) {
        next.push(item);
        rememberAppendedIndex(item, next.length - 1);
        continue;
      }
      // Out-of-order historical item: take the generic sorted-insert path.
      next = upsertConversationItem(next, item);
      indexByIdentity = null;
      continue;
    }

    const updated = applyConversationEventToItems(next, normalizedEvent);
    if (updated !== next) {
      next = updated;
      ownsArray = true;
      indexByIdentity = null;
    }
  }

  return next;
}

/** Apply a conversation-content event to an item array, preserving identity on no-ops. */
export function applyConversationEventToItems(
  items: ConversationItem[],
  event: EventEnvelope,
): ConversationItem[] {
  const normalizedEvent = normalizeEventEnvelope(event);
  switch (normalizedEvent.event.type) {
    case "conversation-item-added":
    case "conversation-item-updated":
      return upsertConversationItem(items, normalizedEvent.event.item);
    case "realtime-item-added":
      return upsertConversationItem(items, {
        kind: "realtime",
        ...normalizedEvent.event.item,
      });
    case "text":
      return applyTextDeltaToConversationItems(items, normalizedEvent.event);
    default:
      return items;
  }
}

export function applyEventToThreadDetail(
  detail: ThreadDetail | null,
  event: EventEnvelope,
) {
  if (!detail) {
    return detail;
  }

  // Only normalize (and reallocate) the detail on branches that actually
  // mutate it. Unrelated events return the original reference unchanged so
  // callers can skip re-rendering.
  const normalizedEvent = normalizeEventEnvelope(event);

  if (
    normalizedEvent.event.type === "workspace-updated" &&
    normalizedEvent.workspace_id === detail.workspace.id
  ) {
    // The stored detail is already normalized (see the content branch below);
    // re-normalizing here would rebuild every item object and defeat memoized
    // rendering on providers that emit workspace/thread updates per chunk.
    return {
      ...detail,
      workspace: normalizedEvent.event.workspace,
    };
  }

  if (normalizedEvent.thread_id !== detail.thread.id) {
    return detail;
  }

  switch (normalizedEvent.event.type) {
    case "thread-updated":
      // Same invariant as workspace-updated above: items are already
      // normalized, and Claude/ACP emit thread-updated alongside nearly every
      // item update, so this branch must not reallocate the transcript.
      return {
        ...detail,
        thread: normalizedEvent.event.thread,
      };
    case "conversation-item-added":
    case "conversation-item-updated":
    case "realtime-item-added":
    case "text": {
      // Only incoming full items are normalized. Re-normalizing the whole detail
      // here would rebuild every item object on every streaming event, which
      // breaks referential equality for items that did not change — defeating
      // memoized message rendering and making long threads visibly stutter as
      // tokens arrive. Details are normalized when fetched (daemon-client and
      // the remote-host client both do it), and every branch here preserves
      // that, so the array is already in normalized form.
      const items = applyConversationEventToItems(
        detail.items,
        normalizedEvent,
      );
      if (items === detail.items) return detail;
      return {
        ...detail,
        items,
        oldest_item_id: items[0]?.id ?? detail.oldest_item_id,
        newest_item_id: items.at(-1)?.id ?? detail.newest_item_id,
      };
    }
    default:
      return detail;
  }
}

/** Applies an ordered event frame to a detail, batching adjacent content updates. */
export function applyEventsToThreadDetail(
  detail: ThreadDetail | null,
  events: EventEnvelope[],
): ThreadDetail | null {
  let next = detail;
  let contentEvents: EventEnvelope[] = [];

  const flushContentEvents = () => {
    if (!next || contentEvents.length === 0) return;
    const items = applyConversationEventsToItems(next.items, contentEvents);
    contentEvents = [];
    if (items === next.items) return;
    next = {
      ...next,
      items,
      oldest_item_id: items[0]?.id ?? next.oldest_item_id,
      newest_item_id: items.at(-1)?.id ?? next.newest_item_id,
    };
  };

  for (const event of events) {
    const eventType = event.event.type;
    const isContentEvent =
      eventType === "conversation-item-added" ||
      eventType === "conversation-item-updated" ||
      eventType === "realtime-item-added" ||
      eventType === "text";
    if (isContentEvent && next && event.thread_id === next.thread.id) {
      contentEvents.push(event);
      continue;
    }
    flushContentEvents();
    next = applyEventToThreadDetail(next, event);
  }
  flushContentEvents();
  return next;
}

export type ToolActivityFamily = "explore" | "command";

export type ToolActivitySummary = {
  family: ToolActivityFamily;
  count: number;
  started_at: string;
  completed_at: string | null;
  title: string;
  subtitle: string | null;
  labels: string[];
  counts: Partial<Record<ToolActivityKind, number>>;
  summary_hint: string | null;
};

export type ConversationHistoryBlock =
  | {
      kind: "item";
      id: string;
      item: ConversationItem;
      default_open: boolean;
      suppress_read_only_detail: boolean;
    }
  | {
      kind: "tool_summary";
      id: string;
      items: Extract<ConversationItem, { kind: "tool_call" }>[];
      summary: ToolActivitySummary;
      default_open: boolean;
      suppress_read_only_detail: boolean;
    }
  | {
      /** One contiguous run of tool work, hidden behind a single line
          ("Working…" / "Worked for 2m 14s") in the collapsed mode. */
      kind: "work_session";
      id: string;
      items: WorkSessionEntry[];
      running: boolean;
      started_at: string;
      completed_at: string | null;
    };

/**
 * What a buried work run can contain. Reasoning rides along with the tool calls
 * it interleaves with so expanding the run reveals the agent's thinking in
 * order — emitting it as its own top-level block instead would shatter one
 * "Worked for 2m" into a column of one-second rows, because providers tend to
 * emit a thought between every pair of tool calls.
 */
export type WorkSessionEntry =
  | Extract<ConversationItem, { kind: "tool_call" }>
  | Extract<ConversationItem, { kind: "reasoning" }>;

export type ConversationRenderBlock = ConversationHistoryBlock;

/**
 * Stable heterogeneous-list classification for conversation rows. Native
 * virtualized lists should recycle assistant, reasoning, tool, media, and
 * grouped-work cells within their own shape rather than treating every
 * ordinary history block as the generic `item` container.
 */
export function conversationRenderBlockType(
  block: ConversationRenderBlock,
): ConversationItem["kind"] | "tool_summary" | "work_session" {
  return block.kind === "item" ? block.item.kind : block.kind;
}

export type ConversationLiveActivityGroup = {
  kind: "live_activity_group";
  id: string;
  items: Extract<ConversationItem, { kind: "tool_call" }>[];
  summary: ToolActivitySummary;
};

export type ConversationPresentation = {
  live_activity_groups: ConversationLiveActivityGroup[];
  history_blocks: ConversationHistoryBlock[];
};

export type ConversationPresentationOptions = {
  /** True while the agent's turn is still streaming. The trailing work
      session stays alive until the turn settles, including short gaps between
      tool calls, so a running thread can never render as finished. */
  is_streaming?: boolean;
};

function sameReferences<T>(left: T[], right: T[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameActivitySummary(
  left: ToolActivitySummary,
  right: ToolActivitySummary,
): boolean {
  if (
    left.family !== right.family ||
    left.count !== right.count ||
    left.started_at !== right.started_at ||
    left.completed_at !== right.completed_at ||
    left.title !== right.title ||
    left.subtitle !== right.subtitle ||
    left.summary_hint !== right.summary_hint ||
    !sameReferences(left.labels, right.labels)
  ) {
    return false;
  }

  const keys = new Set([
    ...Object.keys(left.counts),
    ...Object.keys(right.counts),
  ]);
  for (const key of keys) {
    const activity = key as ToolActivityKind;
    if (left.counts[activity] !== right.counts[activity]) return false;
  }
  return true;
}

function reuseHistoryBlock(
  previous: ConversationHistoryBlock,
  next: ConversationHistoryBlock,
): ConversationHistoryBlock {
  if (previous.kind !== next.kind || previous.id !== next.id) return next;
  if (previous.kind === "item" && next.kind === "item") {
    return previous.item === next.item &&
      previous.default_open === next.default_open &&
      previous.suppress_read_only_detail === next.suppress_read_only_detail
      ? previous
      : next;
  }
  if (previous.kind === "tool_summary" && next.kind === "tool_summary") {
    return sameReferences(previous.items, next.items) &&
      sameActivitySummary(previous.summary, next.summary) &&
      previous.default_open === next.default_open &&
      previous.suppress_read_only_detail === next.suppress_read_only_detail
      ? previous
      : next;
  }
  if (previous.kind === "work_session" && next.kind === "work_session") {
    return sameReferences(previous.items, next.items) &&
      previous.running === next.running &&
      previous.started_at === next.started_at &&
      previous.completed_at === next.completed_at
      ? previous
      : next;
  }
  return next;
}

function reuseLiveActivityGroup(
  previous: ConversationLiveActivityGroup,
  next: ConversationLiveActivityGroup,
): ConversationLiveActivityGroup {
  return previous.id === next.id &&
    sameReferences(previous.items, next.items) &&
    sameActivitySummary(previous.summary, next.summary)
    ? previous
    : next;
}

function reuseById<T extends { id: string; kind: string }>(
  previous: T[],
  next: T[],
  reuse: (previous: T, next: T) => T,
): T[] {
  if (next.length === 0) return previous.length === 0 ? previous : next;
  let previousByKey: Map<string, T> | null = null;
  let allSame = previous.length === next.length;
  const reused = next.map((entry, index) => {
    const atSameIndex = previous[index];
    let prior =
      atSameIndex?.kind === entry.kind && atSameIndex.id === entry.id
        ? atSameIndex
        : undefined;
    if (!prior) {
      previousByKey ??= new Map(
        previous.map((candidate) => [
          `${candidate.kind}:${candidate.id}`,
          candidate,
        ]),
      );
      prior = previousByKey.get(`${entry.kind}:${entry.id}`);
    }
    const value = prior ? reuse(prior, entry) : entry;
    if (value !== previous[index]) allSame = false;
    return value;
  });
  return allSame ? previous : reused;
}

/**
 * Reuses presentation objects whose authoritative item references and display
 * semantics did not change. Streaming still derives the current transcript,
 * but React/FlashList can now skip every completed sibling rather than seeing
 * a new wrapper object for all history on every token.
 */
export function reuseConversationPresentation(
  previous: ConversationPresentation | null | undefined,
  next: ConversationPresentation,
): ConversationPresentation {
  if (!previous) return next;
  const historyBlocks = reuseById(
    previous.history_blocks,
    next.history_blocks,
    reuseHistoryBlock,
  );
  const liveActivityGroups = reuseById(
    previous.live_activity_groups,
    next.live_activity_groups,
    reuseLiveActivityGroup,
  );
  return historyBlocks === previous.history_blocks &&
    liveActivityGroups === previous.live_activity_groups
    ? previous
    : {
        history_blocks: historyBlocks,
        live_activity_groups: liveActivityGroups,
      };
}

function isToolCall(
  item: ConversationItem,
): item is Extract<ConversationItem, { kind: "tool_call" }> {
  return item.kind === "tool_call";
}

export function toolLifecycle(
  item: Pick<
    Extract<ConversationItem, { kind: "tool_call" }>,
    "status" | "exit_code" | "display"
  >,
): ToolLifecycle {
  if (item.exit_code != null && item.exit_code !== 0) return "failed";
  // `unknown` is an explicit compatibility sentinel, not authoritative state.
  // Older or partially normalized history can still carry a useful raw status.
  if (item.display.lifecycle && item.display.lifecycle !== "unknown") {
    return item.display.lifecycle;
  }

  const status = item.status
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  if (["queued", "pending", "created"].includes(status)) return "queued";
  if (
    ["awaiting_confirmation", "awaiting_approval", "pending_approval"].includes(
      status,
    )
  ) {
    return "awaiting_approval";
  }
  if (["running", "in_progress", "inprogress", "streaming"].includes(status)) {
    return item.display.activity_kind === "approval"
      ? "awaiting_approval"
      : "running";
  }
  if (
    ["completed", "complete", "success", "succeeded", "done"].includes(status)
  ) {
    return "succeeded";
  }
  if (["denied", "rejected", "declined"].includes(status)) return "denied";
  if (
    ["interrupted", "cancelled", "canceled", "aborted", "stopped"].includes(
      status,
    )
  ) {
    return "interrupted";
  }
  if (
    ["failed", "failure", "error", "errored", "blocked"].includes(status) ||
    item.display.is_error
  ) {
    return "failed";
  }
  return "unknown";
}

export function fileChangeLifecycle(
  item: Pick<
    Extract<ConversationItem, { kind: "file_change" }>,
    "status" | "lifecycle"
  >,
): ToolLifecycle {
  if (item.lifecycle && item.lifecycle !== "unknown") return item.lifecycle;
  const status = item.status
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  if (["queued", "pending", "created"].includes(status)) return "queued";
  if (["running", "in_progress", "inprogress", "streaming"].includes(status))
    return "running";
  if (
    ["completed", "complete", "success", "succeeded", "done"].includes(status)
  ) {
    return "succeeded";
  }
  if (["denied", "rejected", "declined"].includes(status)) return "denied";
  if (
    ["interrupted", "cancelled", "canceled", "aborted", "stopped"].includes(
      status,
    )
  ) {
    return "interrupted";
  }
  if (["failed", "failure", "error", "errored", "blocked"].includes(status))
    return "failed";
  return "unknown";
}

export function toolLifecycleLabel(lifecycle: ToolLifecycle) {
  switch (lifecycle) {
    case "queued":
      return "Queued";
    case "awaiting_approval":
      return "Awaiting approval";
    case "running":
      return "Running";
    case "succeeded":
      return "Completed";
    case "failed":
      return "Failed";
    case "denied":
      return "Denied";
    case "interrupted":
      return "Interrupted";
    default:
      return "Unknown status";
  }
}

function isActiveTool(item: Extract<ConversationItem, { kind: "tool_call" }>) {
  const lifecycle = toolLifecycle(item);
  return (
    lifecycle === "running" ||
    lifecycle === "awaiting_approval" ||
    lifecycle === "queued"
  );
}

function isAbnormalTerminalTool(
  item: Extract<ConversationItem, { kind: "tool_call" }>,
) {
  const lifecycle = toolLifecycle(item);
  return (
    lifecycle === "failed" ||
    lifecycle === "denied" ||
    lifecycle === "interrupted"
  );
}

/**
 * Whether a failed/denied/interrupted tool may break the fold its mode would
 * otherwise put it in — escaping a summary group, or keeping its detail while
 * read-only details are hidden. Collapsed mode ignores this entirely: its
 * work sessions bury abnormal calls like any other tool.
 *
 * Gated on the same preference that drives auto-expansion, because most failed
 * calls are noise the agent already recovered from: a probe that missed, a
 * grep that matched nothing, a denied read it routed around. Users who turn
 * error auto-expand off are asking for those to stay folded, and the agent
 * still narrates the failures that actually block it in its own message.
 */
function escapesFoldOnError(
  item: Extract<ConversationItem, { kind: "tool_call" }>,
  preferences: FalconDeckPreferences,
) {
  return (
    isAbnormalTerminalTool(item) && preferences.conversation.auto_expand.errors
  );
}

function toolActivityFamily(
  item: Extract<ConversationItem, { kind: "tool_call" }>,
): ToolActivityFamily | null {
  switch (item.display.activity_kind) {
    case "command":
      return "command";
    case "read":
    case "search":
    case "list":
    case "web_search":
    case "image_view":
    case "context":
      return "explore";
    default:
      return null;
  }
}

function isHighSignalTool(
  item: Extract<ConversationItem, { kind: "tool_call" }>,
  mode: ToolDetailsMode,
  seenDiff: { value: boolean },
  preferences: FalconDeckPreferences,
) {
  if (mode === "expanded") return true;
  if (
    item.detail?.kind === "mcp" &&
    summarizeMcpArtifacts(
      item.detail.result,
      item.display.provider_output_summary,
    ).total > 0
  )
    return true;
  if (
    isAbnormalTerminalTool(item) &&
    preferences.conversation.auto_expand.errors
  )
    return true;
  if (
    item.display.artifact_kind === "approval_related" &&
    preferences.conversation.auto_expand.approvals
  ) {
    return true;
  }
  if (
    item.display.artifact_kind === "test" &&
    toolLifecycle(item) === "failed" &&
    preferences.conversation.auto_expand.failed_tests
  ) {
    return true;
  }
  if (item.display.artifact_kind === "diff") {
    const shouldOpen =
      !seenDiff.value && preferences.conversation.auto_expand.first_diff;
    seenDiff.value = true;
    return shouldOpen;
  }
  return false;
}

function isSummarizableTool(
  item: Extract<ConversationItem, { kind: "tool_call" }>,
  preferences: FalconDeckPreferences,
): boolean {
  return (
    preferences.conversation.group_read_only_tools &&
    item.display.history_mode === "summary" &&
    !escapesFoldOnError(item, preferences) &&
    !(
      item.detail?.kind === "mcp" &&
      summarizeMcpArtifacts(
        item.detail.result,
        item.display.provider_output_summary,
      ).total > 0
    ) &&
    toolActivityFamily(item) !== null
  );
}

function shouldSuppressReadOnlyDetail(
  item: ConversationItem,
  mode: ToolDetailsMode,
  preferences: FalconDeckPreferences,
) {
  return (
    (mode === "hide_read_only_details" || mode === "compact") &&
    isToolCall(item) &&
    !(
      item.detail?.kind === "mcp" &&
      summarizeMcpArtifacts(
        item.detail.result,
        item.display.provider_output_summary,
      ).total > 0
    ) &&
    item.display.is_read_only &&
    !item.display.has_side_effect &&
    !escapesFoldOnError(item, preferences)
  );
}

function incrementCount(
  counts: Partial<Record<ToolActivityKind, number>>,
  key: ToolActivityKind,
) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function countLabel(kind: ToolActivityKind, count: number) {
  switch (kind) {
    case "read":
      return `${count} file${count === 1 ? "" : "s"}`;
    case "search":
      return `${count} search${count === 1 ? "" : "es"}`;
    case "list":
      return `${count} list${count === 1 ? "" : "s"}`;
    case "web_search":
      return `${count} web search${count === 1 ? "" : "es"}`;
    case "image_view":
      return `${count} image${count === 1 ? "" : "s"}`;
    case "context":
      return `${count} context step${count === 1 ? "" : "s"}`;
    case "command":
      return `${count} command${count === 1 ? "" : "s"}`;
    default:
      return `${count} tool${count === 1 ? "" : "s"}`;
  }
}

function orderedCountLabels(
  counts: Partial<Record<ToolActivityKind, number>>,
  family: ToolActivityFamily,
) {
  const order: ToolActivityKind[] =
    family === "command"
      ? ["command"]
      : ["read", "search", "list", "web_search", "image_view", "context"];

  return order
    .map((kind) => {
      const count = counts[kind];
      return typeof count === "number" && count > 0
        ? countLabel(kind, count)
        : null;
    })
    .filter((label): label is string => Boolean(label));
}

function buildToolActivitySummary(
  items: Extract<ConversationItem, { kind: "tool_call" }>[],
  family: ToolActivityFamily,
  tense: "live" | "history",
): ToolActivitySummary {
  const labels: string[] = [];
  const counts: Partial<Record<ToolActivityKind, number>> = {};
  for (const item of items) {
    incrementCount(counts, item.display.activity_kind);
    const label = item.display.summary_hint ?? item.title;
    if (!labels.includes(label)) labels.push(label);
    if (labels.length >= 2) break;
  }
  const countLabels = orderedCountLabels(counts, family);
  const title =
    tense === "live"
      ? family === "command"
        ? `Running ${countLabels[0] ?? countLabel("command", items.length)}`
        : `Exploring ${countLabels[0] ?? `${items.length} item${items.length === 1 ? "" : "s"}`}`
      : family === "command"
        ? `Ran ${countLabels.join(", ") || countLabel("command", items.length)}`
        : `Explored ${countLabels.join(", ") || `${items.length} item${items.length === 1 ? "" : "s"}`}`;

  return {
    family,
    count: items.length,
    started_at: items[0]?.created_at ?? new Date(0).toISOString(),
    completed_at: items[items.length - 1]?.completed_at ?? null,
    title,
    subtitle: labels.join(" · ") || null,
    labels,
    counts,
    summary_hint:
      items.find((item) => item.display.summary_hint)?.display.summary_hint ??
      null,
  };
}

/** "Worked for 2m 14s"-style duration between two ISO timestamps. */
export function formatWorkDuration(
  startedAt: string,
  completedAt: string,
): string {
  const seconds = Math.max(
    1,
    Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000),
  );
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function deriveConversationPresentation(
  items: ConversationItem[],
  preferencesInput: FalconDeckPreferences | null | undefined,
  options: ConversationPresentationOptions = {},
): ConversationPresentation {
  const preferences = normalizePreferences(preferencesInput);
  const historyBlocks: ConversationHistoryBlock[] = [];
  const liveActivityGroups: ConversationLiveActivityGroup[] = [];
  const seenDiff = { value: false };
  const mode = preferences.conversation.tool_details_mode;
  let summaryBuffer: Extract<ConversationItem, { kind: "tool_call" }>[] = [];
  let summaryFamily: ToolActivityFamily | null = null;
  let liveBuffer: Extract<ConversationItem, { kind: "tool_call" }>[] = [];
  let liveFamily: ToolActivityFamily | null = null;

  const suppressReadOnlyDetail =
    mode === "hide_read_only_details" || mode === "compact";

  // ChatGPT-style default: bury contiguous tool runs behind one line. Only
  // approvals, diffs, errors, and failed tests break out of the fold.
  if (mode === "collapsed") {
    let workBuffer: WorkSessionEntry[] = [];
    // Receipts (resolved approvals, service notices) gathered during a run.
    // They render as quiet rows after the run they belong to, so they never
    // interrupt the fold.
    let buriedReceipts: ConversationItem[] = [];
    const flushReceipts = () => {
      for (const receipt of buriedReceipts) {
        historyBlocks.push({
          kind: "item",
          id: `${receipt.kind}:${receipt.id}`,
          item: receipt,
          default_open: false,
          suppress_read_only_detail: false,
        });
      }
      buriedReceipts = [];
    };
    const flushWork = () => {
      if (workBuffer.length === 0) {
        flushReceipts();
        return;
      }
      const running = workBuffer.some(
        (entry) => entry.kind === "tool_call" && isActiveTool(entry),
      );
      const last = workBuffer[workBuffer.length - 1]!;
      historyBlocks.push({
        kind: "work_session",
        // Keyed by the first provider item only: folding the running count in
        // would remount the card whenever another tool joins.
        id: `tool_call:${workBuffer[0]!.id}`,
        items: workBuffer,
        running,
        started_at: workBuffer[0]!.created_at,
        completed_at: running
          ? null
          : ((last.kind === "tool_call" ? last.completed_at : null) ??
            last.created_at),
      });
      workBuffer = [];
      flushReceipts();
    };

    for (const item of items) {
      // Reasoning is part of the buried work; don't let it split a run. It
      // joins the open run so expanding reveals it in order, but a thought
      // with no work around it still gets its own block — otherwise it would
      // be labelled "Worked for 1s" when no work happened at all.
      if (item.kind === "reasoning") {
        if (workBuffer.length > 0) {
          workBuffer.push(item);
          continue;
        }
        flushReceipts();
        historyBlocks.push({
          kind: "item",
          id: `${item.kind}:${item.id}`,
          item,
          default_open: false,
          suppress_read_only_detail: false,
        });
        continue;
      }
      // Neither do the receipts that accompany work: resolved approvals and
      // service notices. Rendering them between fragments is what turned one
      // "Worked for 2m" into a column of "Worked for 1s" rows.
      if (item.kind === "interactive_request" && item.resolved) {
        buriedReceipts.push(item);
        continue;
      }
      if (item.kind === "service") {
        buriedReceipts.push(item);
        continue;
      }
      if (isToolCall(item)) {
        const hasProviderArtifacts =
          item.detail?.kind === "mcp" &&
          summarizeMcpArtifacts(
            item.detail.result,
            item.display.provider_output_summary,
          ).total > 0;
        // Unlike the other modes, errors never break this fold — collapsed is
        // the "just tell me what happened" view, and the agent's own message
        // already narrates any failure that mattered. The auto-expand-errors
        // preference still governs the summarizing modes.
        const mustSurface =
          hasProviderArtifacts ||
          (item.display.artifact_kind === "approval_related" &&
            preferences.conversation.auto_expand.approvals) ||
          item.display.artifact_kind === "diff" ||
          // Same rule as errors: the toggle that auto-expands failed tests is
          // also what lets them out of the fold.
          (item.display.artifact_kind === "test" &&
            toolLifecycle(item) === "failed" &&
            preferences.conversation.auto_expand.failed_tests);
        if (!mustSurface) {
          workBuffer.push(item);
          continue;
        }
      }
      flushWork();
      let defaultOpen = false;
      if (isToolCall(item)) {
        defaultOpen = isHighSignalTool(item, mode, seenDiff, preferences);
      } else if (item.kind === "diff" || item.kind === "file_change") {
        defaultOpen =
          !seenDiff.value && preferences.conversation.auto_expand.first_diff;
        seenDiff.value = true;
      }
      historyBlocks.push({
        kind: "item",
        id: `${item.kind}:${item.id}`,
        item,
        default_open: defaultOpen,
        suppress_read_only_detail: shouldSuppressReadOnlyDetail(
          item,
          mode,
          preferences,
        ),
      });
    }
    flushWork();

    // Keep the trailing work session live for the whole turn, including the
    // short gaps between fast tool calls. Settling it as soon as each tool
    // completes makes the row flash "Worked" before returning to "Working".
    // A trailing thought needs the same treatment: it is buried in this fold,
    // so the standalone "Thinking…" line is intentionally suppressed.
    if (options.is_streaming) {
      const tail = historyBlocks[historyBlocks.length - 1];
      if (tail?.kind === "work_session" && !tail.running) {
        tail.running = true;
        tail.completed_at = null;
      }
    }

    // Running work renders as its own "Working…" block, so the pinned live
    // lane stays empty in this mode.
    return {
      live_activity_groups: [],
      history_blocks: historyBlocks,
    };
  }

  const flushSummaryBuffer = () => {
    if (summaryBuffer.length === 0 || !summaryFamily) return;
    historyBlocks.push({
      kind: "tool_summary",
      id: `tool-summary:${summaryBuffer[0]!.id}`,
      items: summaryBuffer,
      summary: buildToolActivitySummary(
        summaryBuffer,
        summaryFamily,
        "history",
      ),
      default_open: mode === "expanded",
      suppress_read_only_detail: suppressReadOnlyDetail,
    });
    summaryBuffer = [];
    summaryFamily = null;
  };

  const flushLiveBuffer = () => {
    if (liveBuffer.length === 0 || !liveFamily) return;
    liveActivityGroups.push({
      kind: "live_activity_group",
      id: `live-activity:${liveBuffer[0]!.id}`,
      items: liveBuffer,
      summary: buildToolActivitySummary(liveBuffer, liveFamily, "live"),
    });
    liveBuffer = [];
    liveFamily = null;
  };

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];

    if (isToolCall(item) && isSummarizableTool(item, preferences)) {
      const family = toolActivityFamily(item);
      if (family) {
        if (isActiveTool(item)) {
          flushSummaryBuffer();
          if (liveFamily && liveFamily !== family) {
            flushLiveBuffer();
          }
          liveFamily = family;
          liveBuffer.push(item);
          continue;
        }

        flushLiveBuffer();
        if (summaryFamily && summaryFamily !== family) {
          flushSummaryBuffer();
        }
        summaryFamily = family;
        summaryBuffer.push(item);
        continue;
      }
    }

    flushSummaryBuffer();
    flushLiveBuffer();

    let defaultOpen = false;
    if (isToolCall(item)) {
      defaultOpen = isHighSignalTool(item, mode, seenDiff, preferences);
    } else if (item.kind === "diff" || item.kind === "file_change") {
      defaultOpen =
        !seenDiff.value && preferences.conversation.auto_expand.first_diff;
      seenDiff.value = true;
    }
    const itemSuppressReadOnlyDetail = shouldSuppressReadOnlyDetail(
      item,
      mode,
      preferences,
    );

    historyBlocks.push({
      kind: "item",
      id: `${item.kind}:${item.id}`,
      item,
      default_open: defaultOpen,
      suppress_read_only_detail: itemSuppressReadOnlyDetail,
    });
  }

  flushSummaryBuffer();
  flushLiveBuffer();

  return {
    live_activity_groups: liveActivityGroups,
    history_blocks: historyBlocks,
  };
}

export function deriveConversationRenderBlocks(
  items: ConversationItem[],
  preferencesInput: FalconDeckPreferences | null | undefined,
  options: ConversationPresentationOptions = {},
): ConversationRenderBlock[] {
  return deriveConversationPresentation(items, preferencesInput, options)
    .history_blocks;
}
