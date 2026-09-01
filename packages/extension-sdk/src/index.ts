export type ExtensionViewScope = { kind: string; id: string };

export type ExtensionUiGap = "none" | "small" | "medium" | "large";
export type ExtensionUiTextStyle = "body" | "heading" | "caption" | "mono";
export type ExtensionUiTone =
  | "default"
  | "muted"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink";
export type ExtensionUiButtonVariant =
  "secondary" | "primary" | "ghost" | "danger";
export type ExtensionUiStateKind = "loading" | "empty" | "error";

export type ExtensionUiActionBinding<TInput = unknown> = {
  actionId: string;
  input?: TInput;
  target?: ExtensionViewScope;
};

export type ExtensionUiFilterBinding = {
  view: string;
  path: string[];
  operator: "includes_any";
};

export type ExtensionUiSelectOption = {
  value: string;
  label: string;
  tone?: ExtensionUiTone;
};

export type ExtensionUiNode =
  | { type: "stack"; gap?: ExtensionUiGap; children: ExtensionUiNode[] }
  | {
      type: "row";
      gap?: ExtensionUiGap;
      wrap?: boolean;
      children: ExtensionUiNode[];
    }
  | {
      type: "text";
      text: string;
      style?: ExtensionUiTextStyle;
      tone?: ExtensionUiTone;
    }
  | { type: "badge"; text: string; tone?: ExtensionUiTone }
  | { type: "divider" }
  | {
      type: "button";
      label: string;
      action: ExtensionUiActionBinding;
      variant?: ExtensionUiButtonVariant;
      disabled?: boolean;
    }
  | { type: "list"; items: ExtensionUiNode[] }
  | {
      type: "select";
      id: string;
      label: string;
      multiple?: boolean;
      options: ExtensionUiSelectOption[];
      binding: ExtensionUiFilterBinding;
    }
  | {
      type: "state";
      state: ExtensionUiStateKind;
      title: string;
      description?: string;
    };

export type ExtensionUiDocument = {
  version: 1;
  root: ExtensionUiNode;
};

/** Preserves literal component and action identifiers while type-checking a document. */
export function defineExtensionUi<const TDocument extends ExtensionUiDocument>(
  document: TDocument,
): TDocument {
  return document;
}

export type ExtensionActionInvocation<TInput = unknown> = {
  target?: ExtensionViewScope;
  input: TInput;
};

export type PublishedExtensionView<TValue = unknown> = {
  viewId: string;
  scope?: ExtensionViewScope;
  value: TValue;
};

export type ExtensionEvent =
  | {
      type: "thread.updated";
      workspaceId: string;
      threadId: string;
    }
  | {
      type: "turn.start";
      workspaceId: string;
      threadId: string;
      turnId: string;
    }
  | {
      type: "turn.ended";
      workspaceId: string;
      threadId: string;
      turnId: string;
    }
  | {
      type: "attention.opened";
      workspaceId: string;
      threadId?: string;
      requestId: string;
    }
  | {
      type: "attention.resolved";
      workspaceId: string;
      threadId?: string;
      requestId: string;
    }
  | {
      type: "orchestration.updated";
      workspaceId: string;
      runId: string;
    };

export type ExtensionEventType = ExtensionEvent["type"];

export type ExtensionDisposable = {
  dispose(): void;
};

export type ExtensionThreadStatus =
  "idle" | "running" | "waiting_for_input" | "error";

/** Summary-only `threads:read` projection. No transcript or message preview is exposed. */
export type ExtensionThreadSummary = {
  id: string;
  workspaceId: string;
  title: string;
  provider: string;
  status: ExtensionThreadStatus;
  updatedAt: string;
  pendingApprovalCount: number;
  pendingQuestionCount: number;
};

export type ExtensionRunGate = "open" | "paused" | "closed";
export type ExtensionRunOutcome =
  | "completed"
  | "closed_incomplete"
  | "expired"
  | "cancelled";
export type ExtensionOperationStatus =
  | "queued"
  | "dispatching"
  | "acknowledged"
  | "settled"
  | "outcome_unknown"
  | "rejected"
  | "cancelled";
export type ExtensionWorkerStatus =
  | "queued"
  | "creating_thread"
  | "thread_ready"
  | "dispatching"
  | "running"
  | "succeeded"
  | "failed"
  | "outcome_unknown"
  | "cancelled";

/** Owner-only durable run projection. Provider transcripts are never exposed. */
export type ExtensionRunSummary = {
  id: string;
  ownerExtensionId: string;
  workspaceId: string;
  coordinatorThreadId: string;
  title: string;
  objective: string;
  gate: ExtensionRunGate;
  outcome?: ExtensionRunOutcome;
  pauseReason?: string;
  checkpoint: unknown;
  policyRevision: number;
  journalSequence: number;
  approvalGeneration: number;
  automaticTurnsStarted: number;
  maxAutomaticTurns: number;
  maxWorkers: number;
  awaitingWorkers: boolean;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  lastProgressFingerprint?: string;
  pendingContinuation?: {
    operationId: string;
    prompt: string;
    progressFingerprint: string;
    requestedAt: string;
  };
  completionProposed: boolean;
  operations: Array<{
    id: string;
    prompt: string;
    status: ExtensionOperationStatus;
    createdAt: string;
    updatedAt: string;
    providerTurnId?: string;
    sourceTurnIdBeforeDispatch?: string;
    message?: string;
  }>;
  workers: Array<{
    id: string;
    provider: string;
    assignment: string;
    status: ExtensionWorkerStatus;
    threadId?: string;
    providerTurnId?: string;
    sourceTurnIdBeforeDispatch?: string;
    report?: string;
    message?: string;
    createdAt: string;
    updatedAt: string;
  }>;
};

export type ExtensionRunCommand =
  | "pause"
  | "resume"
  | "extend"
  | "accept_completion"
  | "close_incomplete";

/**
 * One short, durable orchestration reduction. The daemon validates ownership,
 * actor type, CAS revision, limits and task identity before committing it.
 */
export type ExtensionOrchestrationEffect =
  | {
      type: "create_run";
      runId: string;
      workspaceId: string;
      coordinatorThreadId: string;
      title: string;
      objective: string;
      checkpoint: unknown;
      /** Human-approved hard coordinator-turn budget (default 12, max 24). */
      maxAutomaticTurns?: number;
      /** Human-approved hard worker budget (default 3, max 4). */
      maxWorkers?: number;
      /** Human-approved initial lease in minutes (default 180, max 1440). */
      leaseMinutes?: number;
      initialPrompt?: string;
    }
  | {
      type: "update_checkpoint";
      runId: string;
      expectedPolicyRevision: number;
      checkpoint: unknown;
    }
  | {
      type: "request_continuation";
      runId: string;
      expectedPolicyRevision: number;
      operationId: string;
      checkpoint: unknown;
      progressFingerprint: string;
      prompt: string;
    }
  | {
      type: "delegate_worker";
      runId: string;
      expectedPolicyRevision: number;
      workerId: string;
      provider: string;
      assignment: string;
    }
  | {
      type: "await_workers";
      runId: string;
      expectedPolicyRevision: number;
      checkpoint: unknown;
    }
  | {
      type: "propose_completion";
      runId: string;
      expectedPolicyRevision: number;
      checkpoint: unknown;
    }
  | {
      type: "pause_for_human";
      runId: string;
      expectedPolicyRevision: number;
      checkpoint: unknown;
      reason: string;
    }
  | {
      type: "human_command";
      runId: string;
      expectedPolicyRevision: number;
      command: ExtensionRunCommand;
      resumePrompt?: string;
      operationId?: string;
    };

/** Bounds the daemon enforces on every published suggestion set. */
export const MIN_COMPOSER_SUGGESTIONS = 1;
export const MAX_COMPOSER_SUGGESTIONS = 5;
export const MAX_COMPOSER_SUGGESTION_LABEL_CHARS = 30;
export const MAX_COMPOSER_SUGGESTION_DESCRIPTION_CHARS = 120;
export const MAX_COMPOSER_SUGGESTION_PROMPT_CHARS = 512;
export const MAX_COMPOSER_SUGGESTION_ID_CHARS = 64;

/** One offered next action rendered above the composer. */
export type ComposerSuggestion = {
  /** Identifier unique within the offer set. */
  id: string;
  /** Pill label, at most 30 characters. */
  label: string;
  /** Optional single-line elaboration. */
  description?: string;
  /** Prompt submitted verbatim when the action is chosen. */
  prompt: string;
};

/** A bounded, thread-scoped set of composer offers. */
export type ComposerSuggestionSet = {
  actions: ComposerSuggestion[];
  /** Action shown in the pill's primary segment; defaults to the first. */
  preferredActionId?: string;
  /** Turn the offers were derived from, so stale sets can be discarded. */
  turnId?: string;
};

export type PublishComposerSuggestions = ComposerSuggestionSet & {
  /** Manifest-declared `composerSuggestions` view id. */
  viewId: string;
  /** Thread the offers belong to. */
  threadId: string;
};

/**
 * Checks a suggestion set against the daemon's published bounds and returns
 * the first violation. Mirrors `ComposerSuggestionSet::validate` in Rust so
 * an authoring mistake fails in the extension rather than at the boundary.
 */
export function validateComposerSuggestions(
  set: ComposerSuggestionSet,
): string | null {
  const { actions } = set;
  if (
    !Array.isArray(actions) ||
    actions.length < MIN_COMPOSER_SUGGESTIONS ||
    actions.length > MAX_COMPOSER_SUGGESTIONS
  ) {
    return `composer suggestions must contain between ${MIN_COMPOSER_SUGGESTIONS} and ${MAX_COMPOSER_SUGGESTIONS} actions`;
  }
  const seen = new Set<string>();
  for (const action of actions) {
    const id = action?.id?.trim() ?? "";
    if (!id || [...id].length > MAX_COMPOSER_SUGGESTION_ID_CHARS) {
      return `composer suggestion id must be 1-${MAX_COMPOSER_SUGGESTION_ID_CHARS} characters`;
    }
    if (seen.has(id)) return `duplicate composer suggestion id: ${id}`;
    seen.add(id);
    const label = action.label?.trim() ?? "";
    if (!label || [...label].length > MAX_COMPOSER_SUGGESTION_LABEL_CHARS) {
      return `composer suggestion label must be 1-${MAX_COMPOSER_SUGGESTION_LABEL_CHARS} characters`;
    }
    if (action.description !== undefined) {
      if (
        [...action.description].length >
          MAX_COMPOSER_SUGGESTION_DESCRIPTION_CHARS ||
        action.description.includes("\n")
      ) {
        return `composer suggestion description must be a single line of at most ${MAX_COMPOSER_SUGGESTION_DESCRIPTION_CHARS} characters`;
      }
    }
    const prompt = action.prompt?.trim() ?? "";
    if (!prompt || [...prompt].length > MAX_COMPOSER_SUGGESTION_PROMPT_CHARS) {
      return `composer suggestion prompt must be 1-${MAX_COMPOSER_SUGGESTION_PROMPT_CHARS} characters`;
    }
  }
  const preferred = set.preferredActionId?.trim();
  if (preferred && !actions.some((action) => action.id.trim() === preferred)) {
    return `preferred composer suggestion ${preferred} is not one of the offered actions`;
  }
  return null;
}

/** One agent-initiated call of a manifest-declared `agentTools` entry. */
export type ExtensionToolInvocation<TInput = unknown> = {
  /** Arguments the agent supplied, matching the declared input schema. */
  input: TInput;
  /** Thread the calling turn belongs to, supplied by the daemon. */
  threadId?: string;
  /** Workspace the calling turn runs in, supplied by the daemon. */
  workspaceId?: string;
};

export type ExtensionContext = {
  extension: { id: string };
  actions: {
    register<TInput = unknown, TResult = unknown>(
      id: string,
      handler: (
        invocation: ExtensionActionInvocation<TInput>,
      ) => TResult | Promise<TResult>,
    ): void;
  };
  storage: {
    get<T>(key: string, fallback: T): Promise<T>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  views: { publish<T>(view: PublishedExtensionView<T>): Promise<void> };
  tools: {
    /**
     * Handles calls to a manifest-declared agent tool. Requires the
     * `agent-tools:register` permission; the daemon re-checks enablement and
     * the grant on every call, so a revoked tool fails rather than runs.
     */
    register<TInput = unknown, TResult = unknown>(
      id: string,
      handler: (
        invocation: ExtensionToolInvocation<TInput>,
      ) => TResult | Promise<TResult>,
    ): void;
  };
  composer: {
    /** Publishes a thread's next-action offers, replacing any previous set. */
    publish(suggestions: PublishComposerSuggestions): Promise<void>;
    /** Removes a thread's offers. */
    clear(target: { viewId: string; threadId: string }): Promise<void>;
  };
  events: {
    on<TType extends ExtensionEventType>(
      type: TType,
      handler: (
        event: Extract<ExtensionEvent, { type: TType }>,
      ) => void | Promise<void>,
    ): ExtensionDisposable;
  };
  threads: {
    /** Lists daemon-reduced summaries when `threads:read` is granted. */
    list(): Promise<ExtensionThreadSummary[]>;
  };
  orchestration: {
    /** Lists only runs owned by this extension when its grant is active. */
    list(): Promise<ExtensionRunSummary[]>;
    /** Queues one effect for the daemon to validate after this callback. */
    apply(effect: ExtensionOrchestrationEffect): Promise<void>;
  };
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
  };
};

export type ExtensionDefinition = {
  activate(context: ExtensionContext): void | Promise<void>;
};

export function defineExtension(
  definition: ExtensionDefinition,
): ExtensionDefinition {
  return definition;
}
