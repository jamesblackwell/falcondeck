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
  | { type: "automations.updated" };

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

export type ExtensionAutomationState =
  "enabled" | "paused" | "completed" | "failed";

export type ExtensionAutomationTrigger =
  | { kind: "once"; run_at: string }
  | { kind: "cron"; expression: string; timezone: string }
  | { kind: "interval"; every_seconds: number; anchor_at: string };

export type ExtensionAutomationTask =
  | { kind: "prompt"; instruction: string }
  | {
      kind: "conditional_prompt";
      instruction: string;
      no_action_marker: string;
    };

/** Owner-only, transcript-free Automation projection. */
export type ExtensionOwnedAutomationSummary = {
  id: string;
  resourceId: string;
  revision: number;
  name: string;
  state: ExtensionAutomationState;
  provider: string;
  resolvedSchedule: string;
  nextRunAt?: string;
  latestOutcome?: {
    status: string;
    finishedAt: string;
    preview?: string;
  };
};

export type ExtensionAutomationEffect =
  | {
      type: "create_from_thread";
      resourceId: string;
      sourceWorkspaceId: string;
      sourceThreadId: string;
      idempotencyKey: string;
      name: string;
      description?: string;
      trigger: ExtensionAutomationTrigger;
      task: ExtensionAutomationTask;
      /** Queue the first run as part of creating the Automation. */
      runImmediately?: boolean;
      requiredConnectors?: string[];
      concurrencyPolicy?: "skip" | "queue_one" | "allow";
      misfirePolicy?: "skip" | "run_once";
    }
  | {
      type: "update";
      automationId: string;
      expectedRevision: number;
      name?: string;
      description?: string;
      trigger?: ExtensionAutomationTrigger;
      task?: ExtensionAutomationTask;
      requiredConnectors?: string[];
      concurrencyPolicy?: "skip" | "queue_one" | "allow";
      misfirePolicy?: "skip" | "run_once";
    }
  | {
      type: "pause" | "resume" | "delete";
      automationId: string;
      expectedRevision: number;
    }
  | {
      type: "run_now";
      automationId: string;
      idempotencyKey: string;
    }
  | { type: "pause_resource"; resourceId: string };

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
  /** Verified owner resource when this task came from an Automation owned by
   * the extension handling this tool call. */
  automationOwnerResourceId?: string;
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
  automations: {
    /** Lists only Automations owned by this extension. */
    list(): Promise<ExtensionOwnedAutomationSummary[]>;
    /** Queues one owner-scoped effect for daemon validation after callback. */
    apply(effect: ExtensionAutomationEffect): Promise<void>;
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
