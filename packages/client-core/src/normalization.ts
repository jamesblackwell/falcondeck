import { normalizeControlStateChanged } from "./control";
import { normalizeWorkspaceColors } from "./workspace-colors";
import type {
  AccountSummary,
  AgentCapabilitySummary,
  AgentProvider,
  ConversationItem,
  ConversationCitation,
  ConversationCitationLocator,
  ContentLifecycle,
  ConversationPreferences,
  SkillSummary,
  DaemonSnapshot,
  LibraryWorkspace,
  EventEnvelope,
  FalconDeckPreferences,
  HarnessesOverview,
  HarnessSummary,
  HarnessUpgradeJob,
  UtilityModelChoice,
  UtilityModelPreferences,
  ExtensionSnapshot,
  ScheduledTaskRunSummary,
  ScheduledTaskSummary,
  ImageInput,
  InteractiveRequest,
  InteractiveRequestOutcome,
  ThreadHandle,
  ThreadAgentParams,
  ThreadDetail,
  ThreadSummary,
  ThreadTokenUsage,
  ToolCallDisplay,
  ToolLifecycle,
  WorkspaceAgentSummary,
  WorkspaceSummary,
} from "./types";
import { dedupeCitations } from "./citation";
import { normalizeExtensionUiDocument } from "./extension-ui";
import { formatInspectableValue } from "./inspectable-value";

const DEFAULT_ACCOUNT: AccountSummary = {
  status: "unknown",
  label: "Unavailable",
};

const DEFAULT_SKILL_TRANSLATIONS = {
  codex: null,
  claude: null,
} as const;

const DEFAULT_THREAD_AGENT: ThreadAgentParams = {
  model_id: null,
  reasoning_effort: null,
  collaboration_mode_id: null,
  approval_policy: null,
  service_tier: null,
};

const DEFAULT_TOOL_CALL_DISPLAY: ToolCallDisplay = {
  is_read_only: false,
  has_side_effect: false,
  is_error: false,
  artifact_kind: "none",
  activity_kind: "other",
  history_mode: "full",
  summary_hint: null,
  test_summary: null,
  provider_output_summary: null,
};

const TOOL_LIFECYCLES = new Set<ToolLifecycle>([
  "unknown",
  "queued",
  "awaiting_approval",
  "running",
  "succeeded",
  "failed",
  "denied",
  "interrupted",
]);

// Event envelopes are immutable after normalization. Ingress normalizes once,
// then the same envelope flows through snapshot and conversation reducers; the
// WeakSet makes those defensive downstream calls allocation-free.
const normalizedEventEnvelopes = new WeakSet<object>();

const TASK_STATUSES = new Set(["active", "paused", "completed"]);
const RUN_STATUSES = new Set([
  "queued",
  "running",
  "awaiting_input",
  "succeeded",
  "failed",
  "interrupted",
  "skipped",
]);
const RUN_TRIGGERS = new Set(["scheduled", "late", "manual"]);

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function normalizeScheduledTaskRun(
  value: unknown,
): ScheduledTaskRunSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const run = value as Partial<ScheduledTaskRunSummary>;
  if (
    typeof run.id !== "string" ||
    typeof run.task_id !== "string" ||
    typeof run.status !== "string" ||
    !RUN_STATUSES.has(run.status) ||
    typeof run.trigger !== "string" ||
    !RUN_TRIGGERS.has(run.trigger) ||
    typeof run.scheduled_for !== "string" ||
    typeof run.workspace_id !== "string"
  ) {
    return null;
  }
  return run as ScheduledTaskRunSummary;
}

export function normalizeScheduledTask(
  value: unknown,
): ScheduledTaskSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const task = value as Partial<ScheduledTaskSummary>;
  const schedule = task.schedule as
    Partial<ScheduledTaskSummary["schedule"]> | undefined;
  if (
    typeof task.id !== "string" ||
    typeof task.title !== "string" ||
    typeof task.status !== "string" ||
    !TASK_STATUSES.has(task.status) ||
    !schedule ||
    typeof schedule !== "object" ||
    !["once", "recurring"].includes(schedule.kind ?? "") ||
    typeof schedule.timezone !== "string" ||
    !isValidTimeZone(schedule.timezone) ||
    (schedule.kind === "once" &&
      typeof (schedule as { run_at?: unknown }).run_at !== "string") ||
    (schedule.kind === "recurring" &&
      (typeof (schedule as { rrule?: unknown }).rrule !== "string" ||
        !(schedule as { rrule: string }).rrule.trim())) ||
    typeof task.workspace_id !== "string" ||
    typeof task.provider !== "string" ||
    typeof task.updated_at !== "string"
  ) {
    return null;
  }
  const lastRun = task.last_run
    ? normalizeScheduledTaskRun(task.last_run)
    : null;
  return {
    ...task,
    prompt_preview:
      typeof task.prompt_preview === "string" ? task.prompt_preview : "",
    last_run: lastRun,
  } as ScheduledTaskSummary;
}

/** Normalizes the untrusted request boundary shared by snapshots and history. */
export function normalizeInteractiveRequest(
  value: unknown,
): InteractiveRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  if (
    typeof request.request_id !== "string" ||
    !request.request_id.trim() ||
    typeof request.workspace_id !== "string" ||
    !request.workspace_id.trim() ||
    (request.kind !== "approval" &&
      request.kind !== "question" &&
      request.kind !== "plan_approval") ||
    !Array.isArray(request.questions)
  ) {
    return null;
  }

  const questionIds = new Set<string>();
  const questions =
    request.kind !== "question"
      ? []
      : request.questions.flatMap((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value))
            return [];
          const question = value as Record<string, unknown>;
          const id = typeof question.id === "string" ? question.id.trim() : "";
          if (!id || questionIds.has(id)) return [];
          questionIds.add(id);

          const optionLabels = new Set<string>();
          const options = Array.isArray(question.options)
            ? question.options.flatMap((value) => {
                if (!value || typeof value !== "object" || Array.isArray(value))
                  return [];
                const option = value as Record<string, unknown>;
                const label =
                  typeof option.label === "string" ? option.label.trim() : "";
                if (!label || optionLabels.has(label)) return [];
                optionLabels.add(label);
                return [
                  {
                    label,
                    description:
                      typeof option.description === "string"
                        ? option.description
                        : "",
                  },
                ];
              })
            : null;

          return [
            {
              id,
              header:
                typeof question.header === "string" && question.header.trim()
                  ? question.header
                  : "Question",
              question:
                typeof question.question === "string" &&
                question.question.trim()
                  ? question.question
                  : "Provide additional input.",
              is_other: question.is_other === true,
              is_secret: question.is_secret === true,
              options,
            },
          ];
        });

  const nullableString = (key: string) =>
    typeof request[key] === "string" ? request[key] : null;
  const approval_decisions =
    request.kind === "approval"
      ? Array.isArray(request.approval_decisions)
        ? [
            ...new Set(
              request.approval_decisions.filter(
                (decision): decision is "allow" | "deny" | "always_allow" =>
                  decision === "allow" ||
                  decision === "deny" ||
                  decision === "always_allow",
              ),
            ),
          ]
        : ["allow" as const, "deny" as const]
      : [];
  return {
    request_id: request.request_id,
    workspace_id: request.workspace_id,
    thread_id: nullableString("thread_id"),
    method: typeof request.method === "string" ? request.method : "",
    kind: request.kind,
    approval_decisions,
    title:
      typeof request.title === "string" && request.title.trim()
        ? request.title
        : request.kind === "question"
          ? "Answer question"
          : request.kind === "plan_approval"
            ? "Review implementation plan"
            : "Approval required",
    detail: nullableString("detail"),
    command: nullableString("command"),
    path: nullableString("path"),
    turn_id: nullableString("turn_id"),
    item_id: nullableString("item_id"),
    questions,
    created_at:
      typeof request.created_at === "string"
        ? request.created_at
        : new Date(0).toISOString(),
  };
}

function shouldSuppressSkillToolOutput(title: string, kind: string) {
  const normalizedTitle = title.toLowerCase().replaceAll("\\", "/");
  const normalizedKind = kind.toLowerCase();

  return (
    normalizedTitle.startsWith("load skill") ||
    normalizedTitle.includes(".agents/skills/") ||
    normalizedTitle.includes(".codex/skills/") ||
    normalizedTitle.includes(".claude/commands/") ||
    normalizedTitle.includes("/skill.md") ||
    normalizedTitle.split(/[\s/:]+/).includes("skill.md") ||
    normalizedKind === "skill" ||
    normalizedKind === "skill_load" ||
    normalizedKind === "skillload" ||
    normalizedKind === "load_skill"
  );
}

const DEFAULT_CONVERSATION_PREFERENCES: ConversationPreferences = {
  tool_details_mode: "collapsed",
  auto_expand: {
    approvals: true,
    errors: true,
    first_diff: true,
    failed_tests: true,
  },
  group_read_only_tools: true,
  show_expand_all_controls: true,
  thinking_display: "auto",
  collapse_long_user_messages: true,
};

const DEFAULT_NOTIFICATION_PREFERENCES = {
  enabled: true,
  notify_on_turn_complete: true,
  notify_on_input_required: true,
  notify_on_error: true,
  suppress_when_desktop_active: true,
} as const;

// Mirrors the daemon's shipped chain: most users have exactly one of these
// CLIs installed, so background work falls down the list until one answers.
const DEFAULT_UTILITY_PROVIDER_ORDER = [
  "claude",
  "codex",
  "opencode",
  "grok",
] as const;

const DEFAULT_UTILITY_MODEL_PREFERENCES: UtilityModelPreferences = {
  provider_order: [...DEFAULT_UTILITY_PROVIDER_ORDER],
  models: [{ provider: "claude", model_id: "haiku" }],
};

const DEFAULT_PREFERENCES: FalconDeckPreferences = {
  version: 1,
  workspace_order: [],
  workspace_colors: {},
  conversation: DEFAULT_CONVERSATION_PREFERENCES,
  notifications: DEFAULT_NOTIFICATION_PREFERENCES,
  utility_models: DEFAULT_UTILITY_MODEL_PREFERENCES,
};

const FALLBACK_PROVIDER: AgentProvider = "codex";

const DEFAULT_CAPABILITIES: AgentCapabilitySummary = {
  supports_review: false,
  supports_goals: false,
  supports_images: false,
  supports_skills: false,
  supports_interrupt: false,
  supports_steering: false,
  supports_forking: false,
  supports_compaction: false,
  supports_compaction_instructions: false,
  sandbox_modes: [],
  permission_modes: [],
};

/**
 * Provider ids are open-ended, so anything non-empty passes through untouched —
 * relabelling an unknown provider as codex would silently route its threads to
 * the wrong agent. Only missing/blank values fall back.
 */
function normalizeProvider(value: unknown): AgentProvider {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : FALLBACK_PROVIDER;
}

/** Title-cased provider id, used when the daemon sends no label. */
export function defaultProviderLabel(provider: AgentProvider): string {
  if (!provider) return "";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0,
  );
}

function normalizeOptionalString(
  value: unknown,
  maxLength = 2_000,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeCapabilities(value: unknown): AgentCapabilitySummary {
  const capabilities = (value ?? {}) as Partial<AgentCapabilitySummary>;
  return {
    supports_review: capabilities.supports_review ?? false,
    supports_goals: capabilities.supports_goals ?? false,
    supports_images: capabilities.supports_images ?? false,
    supports_skills: capabilities.supports_skills ?? false,
    supports_interrupt: capabilities.supports_interrupt ?? false,
    supports_steering: capabilities.supports_steering ?? false,
    supports_forking: capabilities.supports_forking ?? false,
    supports_compaction: capabilities.supports_compaction ?? false,
    supports_compaction_instructions:
      capabilities.supports_compaction_instructions ?? false,
    sandbox_modes: normalizeStringList(capabilities.sandbox_modes),
    permission_modes: normalizeStringList(capabilities.permission_modes),
  };
}

function normalizeAccount(value: unknown): AccountSummary {
  if (!value || typeof value !== "object") {
    return DEFAULT_ACCOUNT;
  }

  const account = value as Partial<AccountSummary>;
  return {
    status:
      account.status === "ready" || account.status === "needs_auth"
        ? account.status
        : "unknown",
    label:
      typeof account.label === "string" && account.label.trim().length > 0
        ? account.label
        : DEFAULT_ACCOUNT.label,
  };
}

function normalizeThreadAgent(value: unknown): ThreadAgentParams {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_THREAD_AGENT };
  }

  const agent = value as Partial<ThreadAgentParams>;
  return {
    model_id: agent.model_id ?? null,
    reasoning_effort: agent.reasoning_effort ?? null,
    collaboration_mode_id: agent.collaboration_mode_id ?? null,
    approval_policy: agent.approval_policy ?? null,
    service_tier: agent.service_tier ?? null,
    permission_mode: agent.permission_mode ?? null,
    sandbox_mode: agent.sandbox_mode ?? null,
  };
}

function normalizeSkillAvailability(
  value: unknown,
): SkillSummary["availability"] {
  return value === "claude" || value === "both" ? value : "codex";
}

function normalizeSkillSourceKind(value: unknown): SkillSummary["source_kind"] {
  return value === "project_file" || value === "home_file"
    ? value
    : "provider_native";
}

/** Expands the legacy availability lattice into an open provider list. */
function skillProvidersFromAvailability(
  availability: SkillSummary["availability"],
): AgentProvider[] {
  if (availability === "both") return ["codex", "claude"];
  return [availability];
}

export function normalizeSkillSummaries(value: unknown): SkillSummary[] {
  return Array.isArray(value)
    ? value.map((entry) => normalizeSkill(entry))
    : [];
}

function normalizeSkill(value: unknown): SkillSummary {
  const skill = (value ?? {}) as Partial<SkillSummary>;
  const alias =
    typeof skill.alias === "string" && skill.alias.trim().length > 0
      ? skill.alias.startsWith("/")
        ? skill.alias
        : `/${skill.alias}`
      : "/";
  const availability = normalizeSkillAvailability(skill.availability);
  const providers = normalizeStringList(skill.providers);
  return {
    id: skill.id ?? alias,
    label:
      typeof skill.label === "string" && skill.label.trim().length > 0
        ? skill.label
        : alias.slice(1) || "skill",
    alias,
    availability,
    providers:
      providers.length > 0
        ? providers
        : skillProvidersFromAvailability(availability),
    source_kind: normalizeSkillSourceKind(skill.source_kind),
    source_path: skill.source_path ?? null,
    description: skill.description ?? null,
    provider_translations: {
      ...DEFAULT_SKILL_TRANSLATIONS,
      ...(skill.provider_translations ?? {}),
    },
  };
}

// Daemons older than the multi-provider rollout omit `capabilities`. Falling
// back to all-false there would strip the sandbox picker and goal control from
// providers that have always supported them, so the two providers that predate
// the field keep their known capability sets when it is absent entirely.
const LEGACY_CAPABILITIES: Record<string, AgentCapabilitySummary> = {
  codex: {
    supports_review: true,
    supports_goals: true,
    supports_images: true,
    supports_skills: true,
    supports_interrupt: true,
    supports_steering: false,
    supports_forking: false,
    // Manual compaction also requires the new daemon API, so an older daemon
    // that omitted this capability cannot safely expose the command.
    supports_compaction: false,
    supports_compaction_instructions: false,
    sandbox_modes: ["read-only", "workspace-write", "danger-full-access"],
    permission_modes: [
      "default",
      "untrusted",
      "on-failure",
      "on-request",
      "never",
    ],
  },
  claude: {
    supports_review: false,
    supports_goals: true,
    supports_images: true,
    supports_skills: true,
    supports_interrupt: true,
    // Unlike the others, steering postdates this fallback: a daemon old enough
    // to omit `capabilities` cannot inject into a running turn.
    supports_steering: false,
    supports_forking: false,
    supports_compaction: false,
    supports_compaction_instructions: false,
    sandbox_modes: [],
    permission_modes: [
      "default",
      "acceptEdits",
      "auto",
      "manual",
      "dontAsk",
      "plan",
      "bypassPermissions",
    ],
  },
};

function capabilitiesForAgent(
  provider: AgentProvider,
  value: unknown,
): AgentCapabilitySummary {
  if (value == null) {
    return LEGACY_CAPABILITIES[provider] ?? { ...DEFAULT_CAPABILITIES };
  }
  return normalizeCapabilities(value);
}

function fallbackWorkspaceAgent(
  workspace: Partial<WorkspaceSummary>,
): WorkspaceAgentSummary {
  return {
    provider: FALLBACK_PROVIDER,
    label: defaultProviderLabel(FALLBACK_PROVIDER),
    account: normalizeAccount(workspace.account),
    models: workspace.models ?? [],
    collaboration_modes: workspace.collaboration_modes ?? [],
    skills: (workspace.skills ?? []).map((skill) => normalizeSkill(skill)),
    capabilities: capabilitiesForAgent(FALLBACK_PROVIDER, null),
  };
}

function normalizeWorkspaceAgent(
  value: unknown,
  fallback: Partial<WorkspaceSummary>,
): WorkspaceAgentSummary {
  if (!value || typeof value !== "object") {
    return fallbackWorkspaceAgent(fallback);
  }

  const agent = value as Partial<WorkspaceAgentSummary>;
  const provider = normalizeProvider(agent.provider);
  return {
    provider,
    label:
      typeof agent.label === "string" && agent.label.trim().length > 0
        ? agent.label
        : defaultProviderLabel(provider),
    account: normalizeAccount(agent.account),
    models: agent.models ?? [],
    collaboration_modes: agent.collaboration_modes ?? [],
    skills: (agent.skills ?? []).map((skill) => normalizeSkill(skill)),
    capabilities: capabilitiesForAgent(provider, agent.capabilities),
  };
}

export function normalizeThreadSummary(
  value: ThreadSummary | unknown,
): ThreadSummary {
  const thread = (value ?? {}) as Partial<ThreadSummary> & {
    codex?: Partial<ThreadAgentParams> | null;
  };

  return {
    id: thread.id ?? "",
    workspace_id: thread.workspace_id ?? "",
    title: thread.title ?? "Untitled thread",
    provider: normalizeProvider(thread.provider),
    native_session_id: thread.native_session_id ?? null,
    provider_transport: thread.provider_transport ?? null,
    handoff_from:
      thread.handoff_from && typeof thread.handoff_from.thread_id === "string"
        ? {
            thread_id: thread.handoff_from.thread_id,
            provider: normalizeProvider(thread.handoff_from.provider),
          }
        : null,
    origin:
      (thread.origin?.kind === "scheduled_task" &&
        typeof thread.origin.task_id === "string" &&
        typeof thread.origin.title === "string") ||
      (thread.origin?.kind === "automation" &&
        typeof thread.origin.automation_id === "string" &&
        typeof thread.origin.name === "string") ||
      (thread.origin?.kind === "mission_worker" &&
        typeof thread.origin.run_id === "string" &&
        typeof thread.origin.worker_id === "string" &&
        typeof thread.origin.title === "string")
        ? thread.origin
        : null,
    status: thread.status ?? "idle",
    updated_at: thread.updated_at ?? new Date(0).toISOString(),
    last_message_preview: thread.last_message_preview ?? null,
    latest_turn_id: thread.latest_turn_id ?? null,
    latest_plan: thread.latest_plan ?? null,
    latest_diff: thread.latest_diff ?? null,
    last_tool: thread.last_tool ?? null,
    last_error: thread.last_error ?? null,
    agent: normalizeThreadAgent(thread.agent ?? thread.codex),
    attention: {
      level: thread.attention?.level ?? "none",
      badge_label: thread.attention?.badge_label ?? null,
      unread: thread.attention?.unread ?? false,
      pending_approval_count: thread.attention?.pending_approval_count ?? 0,
      pending_question_count: thread.attention?.pending_question_count ?? 0,
      last_agent_activity_seq: thread.attention?.last_agent_activity_seq ?? 0,
      last_read_seq: thread.attention?.last_read_seq ?? 0,
    },
    is_archived: thread.is_archived ?? false,
    is_pinned: thread.is_pinned ?? false,
    is_pinned_in_project: thread.is_pinned_in_project ?? false,
    goal: thread.goal ?? null,
    queued_turns: Array.isArray(thread.queued_turns)
      ? thread.queued_turns.filter(
          (queued): queued is ThreadSummary["queued_turns"][number] =>
            typeof queued?.id === "string" &&
            typeof queued?.preview === "string",
        )
      : [],
    // A variant without a path cannot be acted on, so treat it as absent
    // rather than showing a branch chip for a checkout we cannot locate.
    variant:
      thread.variant &&
      typeof thread.variant.path === "string" &&
      thread.variant.path
        ? {
            slug: thread.variant.slug ?? "",
            path: thread.variant.path,
            branch: thread.variant.branch ?? "",
            kind: thread.variant.kind === "worktree" ? "worktree" : "clone",
            base_branch:
              typeof thread.variant.base_branch === "string"
                ? thread.variant.base_branch
                : null,
          }
        : null,
  };
}

export function normalizeLibraryWorkspace(
  value: LibraryWorkspace | unknown,
): LibraryWorkspace | null {
  if (!value || typeof value !== "object") return null;
  const workspace = value as Partial<LibraryWorkspace>;
  if (typeof workspace.id !== "string" || workspace.id.trim().length === 0) {
    return null;
  }
  if (
    typeof workspace.path !== "string" ||
    workspace.path.trim().length === 0
  ) {
    return null;
  }
  if (
    typeof workspace.last_opened_at !== "string" ||
    workspace.last_opened_at.trim().length === 0
  ) {
    return null;
  }
  return {
    id: workspace.id,
    path: workspace.path,
    kind: workspace.kind === "casual" ? "casual" : "project",
    last_opened_at: workspace.last_opened_at,
  };
}

export function normalizeWorkspaceSummary(
  value: WorkspaceSummary | unknown,
): WorkspaceSummary {
  const workspace = (value ?? {}) as Partial<WorkspaceSummary>;
  const agents =
    workspace.agents?.map((agent) =>
      normalizeWorkspaceAgent(agent, workspace),
    ) ?? [];

  return {
    id: workspace.id ?? "",
    path: workspace.path ?? "",
    kind: workspace.kind === "casual" ? "casual" : "project",
    status: workspace.status ?? "disconnected",
    agents: agents.length > 0 ? agents : [fallbackWorkspaceAgent(workspace)],
    skills: (workspace.skills ?? []).map((skill) => normalizeSkill(skill)),
    default_provider: normalizeProvider(workspace.default_provider),
    models: workspace.models ?? [],
    collaboration_modes: workspace.collaboration_modes ?? [],
    account: normalizeAccount(workspace.account),
    current_thread_id: workspace.current_thread_id ?? null,
    connected_at: workspace.connected_at ?? new Date(0).toISOString(),
    updated_at:
      workspace.updated_at ??
      workspace.connected_at ??
      new Date(0).toISOString(),
    last_error: workspace.last_error ?? null,
  };
}

function malformedConversationItem(
  value: unknown,
  outputKind: string | null,
): ConversationItem {
  const fingerprint = formatInspectableValue(value, {
    maxDepth: 3,
    maxEntries: 20,
    maxNodes: 50,
    maxStringLength: 1_000,
    maxOutputLength: 4_000,
  }).text;
  let hash = 2166136261;
  for (let index = 0; index < fingerprint.length; index += 1) {
    hash ^= fingerprint.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return {
    kind: "unsupported",
    id: `malformed-${(hash >>> 0).toString(36)}`,
    output_kind: outputKind,
    reason: "Malformed conversation output",
    payload: value,
    lifecycle: "complete",
    created_at: new Date(0).toISOString(),
  };
}

function normalizeCitationLocator(
  value: unknown,
): ConversationCitationLocator | null {
  if (!value || typeof value !== "object") return null;
  const locator = value as Record<string, unknown>;
  const integer = (key: string, minimum = 0) => {
    const candidate = locator[key];
    return Number.isSafeInteger(candidate) && (candidate as number) >= minimum
      ? (candidate as number)
      : null;
  };
  const fileId =
    typeof locator.file_id === "string" && locator.file_id.trim()
      ? locator.file_id.trim()
      : null;

  if (locator.kind === "web_search") {
    const encryptedIndex =
      typeof locator.encrypted_index === "string"
        ? locator.encrypted_index.trim()
        : "";
    return encryptedIndex
      ? { kind: "web_search", encrypted_index: encryptedIndex }
      : null;
  }
  if (locator.kind === "search_result") {
    const searchResultIndex = integer("search_result_index");
    const startBlockIndex = integer("start_block_index");
    const endBlockIndex = integer("end_block_index");
    return searchResultIndex != null &&
      startBlockIndex != null &&
      endBlockIndex != null &&
      endBlockIndex > startBlockIndex
      ? {
          kind: "search_result",
          search_result_index: searchResultIndex,
          start_block_index: startBlockIndex,
          end_block_index: endBlockIndex,
        }
      : null;
  }
  if (locator.kind === "char") {
    const documentIndex = integer("document_index");
    const startCharIndex = integer("start_char_index");
    const endCharIndex = integer("end_char_index");
    return documentIndex != null &&
      startCharIndex != null &&
      endCharIndex != null &&
      endCharIndex > startCharIndex
      ? {
          kind: "char",
          document_index: documentIndex,
          start_char_index: startCharIndex,
          end_char_index: endCharIndex,
          file_id: fileId,
        }
      : null;
  }
  if (locator.kind === "page") {
    const documentIndex = integer("document_index");
    const startPageNumber = integer("start_page_number", 1);
    const endPageNumber = integer("end_page_number", 1);
    return documentIndex != null &&
      startPageNumber != null &&
      endPageNumber != null &&
      endPageNumber >= startPageNumber
      ? {
          kind: "page",
          document_index: documentIndex,
          start_page_number: startPageNumber,
          end_page_number: endPageNumber,
          file_id: fileId,
        }
      : null;
  }
  if (locator.kind === "content_block") {
    const documentIndex = integer("document_index");
    const startBlockIndex = integer("start_block_index");
    const endBlockIndex = integer("end_block_index");
    return documentIndex != null &&
      startBlockIndex != null &&
      endBlockIndex != null &&
      endBlockIndex > startBlockIndex
      ? {
          kind: "content_block",
          document_index: documentIndex,
          start_block_index: startBlockIndex,
          end_block_index: endBlockIndex,
          file_id: fileId,
        }
      : null;
  }
  return null;
}

function malformedKnownConversationKind(
  item: Record<string, unknown>,
  kind: string,
) {
  const string = (key: string) => typeof item[key] === "string";
  const nullableString = (key: string) =>
    item[key] == null || typeof item[key] === "string";
  switch (kind) {
    case "user_message":
      return (
        !string("id") ||
        !string("text") ||
        (item.attachments != null && !Array.isArray(item.attachments))
      );
    case "assistant_message":
      return !string("id") || !string("text");
    case "reasoning":
      return (
        !string("id") ||
        !string("content") ||
        !nullableString("summary") ||
        (item.duration_ms != null &&
          (!Number.isSafeInteger(item.duration_ms) ||
            (item.duration_ms as number) < 0))
      );
    case "code_review":
      return !string("id") || !string("content") || !nullableString("subject");
    case "context_compaction":
      return !string("id") || !nullableString("completed_at");
    case "artifact": {
      const artifact = item.artifact;
      if (!string("id") || !artifact || typeof artifact !== "object")
        return true;
      const value = artifact as Record<string, unknown>;
      return (
        typeof value.title !== "string" ||
        typeof value.artifact_kind !== "string" ||
        (value.url != null && typeof value.url !== "string") ||
        (value.mime_type != null && typeof value.mime_type !== "string") ||
        (value.version != null && typeof value.version !== "string") ||
        (value.content != null && typeof value.content !== "string")
      );
    }
    case "unsupported":
      return (
        !string("id") || !nullableString("output_kind") || !string("reason")
      );
    case "image": {
      const image = item.image;
      return (
        !string("id") ||
        !image ||
        typeof image !== "object" ||
        typeof (image as Record<string, unknown>).url !== "string"
      );
    }
    case "web_search": {
      const search = item.search;
      return (
        !string("id") ||
        !search ||
        typeof search !== "object" ||
        typeof (search as Record<string, unknown>).id !== "string" ||
        typeof (search as Record<string, unknown>).query !== "string" ||
        typeof (search as Record<string, unknown>).action_kind !== "string" ||
        !Array.isArray((search as Record<string, unknown>).queries)
      );
    }
    case "file_change":
      return !string("id") || !Array.isArray(item.changes) || !string("status");
    case "tool_call":
      return (
        !string("id") ||
        !string("title") ||
        !string("tool_kind") ||
        !string("status") ||
        !nullableString("output") ||
        (item.exit_code != null && typeof item.exit_code !== "number")
      );
    case "plan": {
      const plan = item.plan;
      if (!string("id") || !plan || typeof plan !== "object") return true;
      const steps = (plan as Record<string, unknown>).steps;
      return (
        !Array.isArray(steps) ||
        steps.some(
          (step) =>
            !step ||
            typeof step !== "object" ||
            typeof (step as Record<string, unknown>).step !== "string" ||
            typeof (step as Record<string, unknown>).status !== "string",
        )
      );
    }
    case "diff":
      return !string("id") || !string("diff");
    case "service":
      return (
        !string("id") ||
        !string("message") ||
        (item.level !== "info" &&
          item.level !== "warning" &&
          item.level !== "error")
      );
    case "realtime":
      return (
        !string("id") ||
        !string("item_type") ||
        !string("title") ||
        !nullableString("summary")
      );
    case "interactive_request":
      if (!string("id") || !item.request || typeof item.request !== "object")
        return true;
      return normalizeInteractiveRequest(item.request) === null;
    default:
      return false;
  }
}

export function normalizeConversationItem(value: unknown): ConversationItem {
  if (!value || typeof value !== "object") {
    return malformedConversationItem(value, null);
  }
  const record = value as Record<string, unknown>;
  let kind: string | null = null;
  try {
    kind = typeof record.kind === "string" ? record.kind : null;
  } catch {
    return malformedConversationItem(value, null);
  }
  if (!kind) return malformedConversationItem(value, null);
  try {
    if (malformedKnownConversationKind(record, kind)) {
      return malformedConversationItem(value, kind);
    }
  } catch {
    return malformedConversationItem(value, kind);
  }
  const item = value as ConversationItem;
  if (item.kind === "user_message") {
    return {
      ...item,
      attachments: Array.isArray(item.attachments)
        ? (item.attachments as Array<Record<string, unknown> | null>)
            .filter(
              (attachment): attachment is Record<string, unknown> =>
                !!attachment &&
                // The daemon's ImageInput carries no `type` discriminant on
                // the wire; only reject attachments claiming another type.
                (attachment.type === "image" ||
                  attachment.type === undefined) &&
                typeof attachment.id === "string" &&
                typeof attachment.url === "string",
            )
            .map(
              (attachment) => ({ ...attachment, type: "image" }) as ImageInput,
            )
        : [],
    };
  }
  if (item.kind === "plan") {
    return {
      ...item,
      plan: {
        ...item.plan,
        steps: item.plan.steps.map((step) => ({
          ...step,
          id: typeof step.id === "string" && step.id.trim() ? step.id : null,
        })),
      },
    };
  }
  if (item.kind === "interactive_request") {
    const request = normalizeInteractiveRequest(item.request);
    if (!request) return malformedConversationItem(value, item.kind);
    const resolution = (item as { resolution?: unknown }).resolution;
    const outcome =
      resolution && typeof resolution === "object"
        ? (resolution as { outcome?: unknown }).outcome
        : null;
    const resolvedAt =
      resolution && typeof resolution === "object"
        ? (resolution as { resolved_at?: unknown }).resolved_at
        : null;
    const normalizedOutcome: InteractiveRequestOutcome | null =
      outcome === "allowed" ||
      outcome === "always_allowed" ||
      outcome === "denied" ||
      outcome === "answered" ||
      outcome === "plan_approved" ||
      outcome === "plan_changes_requested" ||
      outcome === "plan_abandoned" ||
      outcome === "expired" ||
      outcome === "cancelled"
        ? outcome
        : null;
    const normalizedResolution =
      normalizedOutcome && typeof resolvedAt === "string"
        ? { outcome: normalizedOutcome, resolved_at: resolvedAt }
        : null;
    return {
      ...item,
      request,
      resolved: Boolean(item.resolved) || normalizedResolution !== null,
      resolution: normalizedResolution,
    };
  }
  if (item.kind === "tool_call") {
    const detail = item.detail;
    return {
      ...item,
      output: shouldSuppressSkillToolOutput(item.title, item.tool_kind)
        ? null
        : item.output,
      display: correctMisclassifiedApproval(
        item,
        normalizeToolCallDisplay((item as { display?: unknown }).display),
      ),
      detail:
        detail?.kind === "command_execution" &&
        typeof detail.command === "string" &&
        typeof detail.cwd === "string"
          ? {
              kind: "command_execution",
              command: detail.command,
              cwd: detail.cwd,
              actions: Array.isArray(detail.actions)
                ? detail.actions.filter(
                    (action) =>
                      action &&
                      typeof action.action_kind === "string" &&
                      typeof action.command === "string",
                  )
                : [],
              process_id:
                typeof detail.process_id === "string"
                  ? detail.process_id
                  : null,
              duration_ms: Number.isFinite(detail.duration_ms)
                ? detail.duration_ms
                : null,
              source: typeof detail.source === "string" ? detail.source : null,
            }
          : detail?.kind === "mcp" &&
              typeof detail.server === "string" &&
              typeof detail.tool === "string"
            ? {
                kind: "mcp",
                server: detail.server,
                tool: detail.tool,
                arguments: detail.arguments ?? null,
                result: detail.result ?? null,
                error: typeof detail.error === "string" ? detail.error : null,
                duration_ms: Number.isFinite(detail.duration_ms)
                  ? detail.duration_ms
                  : null,
                app_context:
                  detail.app_context &&
                  typeof detail.app_context.connector_id === "string"
                    ? {
                        connector_id: detail.app_context.connector_id,
                        app_name:
                          typeof detail.app_context.app_name === "string"
                            ? detail.app_context.app_name
                            : null,
                        action_name:
                          typeof detail.app_context.action_name === "string"
                            ? detail.app_context.action_name
                            : null,
                        link_id:
                          typeof detail.app_context.link_id === "string"
                            ? detail.app_context.link_id
                            : null,
                        resource_uri:
                          typeof detail.app_context.resource_uri === "string"
                            ? detail.app_context.resource_uri
                            : null,
                        template_id:
                          typeof detail.app_context.template_id === "string"
                            ? detail.app_context.template_id
                            : null,
                      }
                    : null,
              }
            : detail?.kind === "dynamic" && typeof detail.tool === "string"
              ? {
                  kind: "dynamic",
                  tool: detail.tool,
                  namespace:
                    typeof detail.namespace === "string"
                      ? detail.namespace
                      : null,
                  arguments: detail.arguments ?? null,
                  content_items: Array.isArray(detail.content_items)
                    ? detail.content_items.filter(
                        (content) =>
                          (content.kind === "text" &&
                            typeof content.text === "string") ||
                          (content.kind === "image" &&
                            typeof content.url === "string"),
                      )
                    : [],
                  success:
                    typeof detail.success === "boolean" ? detail.success : null,
                  duration_ms: Number.isFinite(detail.duration_ms)
                    ? detail.duration_ms
                    : null,
                }
              : detail?.kind === "collab_agent" &&
                  typeof detail.tool === "string" &&
                  typeof detail.sender_thread_id === "string"
                ? {
                    kind: "collab_agent",
                    tool: detail.tool,
                    sender_thread_id: detail.sender_thread_id,
                    receiver_thread_ids: Array.isArray(
                      detail.receiver_thread_ids,
                    )
                      ? detail.receiver_thread_ids.filter(
                          (id): id is string => typeof id === "string",
                        )
                      : [],
                    prompt:
                      typeof detail.prompt === "string" ? detail.prompt : null,
                    model:
                      typeof detail.model === "string" ? detail.model : null,
                    reasoning_effort:
                      typeof detail.reasoning_effort === "string"
                        ? detail.reasoning_effort
                        : null,
                    agent_states: Object.fromEntries(
                      Object.entries(detail.agent_states ?? {}).flatMap(
                        ([id, state]) =>
                          state && typeof state.status === "string"
                            ? [
                                [
                                  id,
                                  {
                                    status: state.status,
                                    message:
                                      typeof state.message === "string"
                                        ? state.message
                                        : null,
                                  },
                                ],
                              ]
                            : [],
                      ),
                    ),
                  }
                : detail?.kind === "subagent_activity" &&
                    typeof detail.activity === "string" &&
                    typeof detail.agent_thread_id === "string" &&
                    typeof detail.agent_path === "string"
                  ? {
                      kind: "subagent_activity",
                      activity: detail.activity,
                      agent_thread_id: detail.agent_thread_id,
                      agent_path: detail.agent_path,
                    }
                  : detail?.kind === "hook" &&
                      typeof detail.event_name === "string" &&
                      typeof detail.handler_type === "string" &&
                      typeof detail.execution_mode === "string" &&
                      typeof detail.scope === "string" &&
                      typeof detail.source_path === "string"
                    ? {
                        kind: "hook",
                        event_name: detail.event_name,
                        handler_type: detail.handler_type,
                        execution_mode: detail.execution_mode,
                        scope: detail.scope,
                        source_path: detail.source_path,
                        duration_ms: Number.isFinite(detail.duration_ms)
                          ? detail.duration_ms
                          : null,
                        status_message:
                          typeof detail.status_message === "string"
                            ? detail.status_message
                            : null,
                        entries: Array.isArray(detail.entries)
                          ? detail.entries.filter(
                              (entry) =>
                                entry &&
                                typeof entry.entry_kind === "string" &&
                                typeof entry.text === "string",
                            )
                          : [],
                      }
                    : detail?.kind === "guardian_review" &&
                        typeof detail.review_id === "string" &&
                        typeof detail.action_kind === "string" &&
                        typeof detail.action === "string" &&
                        typeof detail.status === "string"
                      ? {
                          kind: "guardian_review",
                          review_id: detail.review_id,
                          action_kind: detail.action_kind,
                          action: detail.action,
                          cwd:
                            typeof detail.cwd === "string" ? detail.cwd : null,
                          target_item_id:
                            typeof detail.target_item_id === "string"
                              ? detail.target_item_id
                              : null,
                          status: detail.status,
                          risk_level:
                            typeof detail.risk_level === "string"
                              ? detail.risk_level
                              : null,
                          user_authorization:
                            typeof detail.user_authorization === "string"
                              ? detail.user_authorization
                              : null,
                          rationale:
                            typeof detail.rationale === "string"
                              ? detail.rationale
                              : null,
                          decision_source:
                            typeof detail.decision_source === "string"
                              ? detail.decision_source
                              : null,
                          duration_ms: Number.isFinite(detail.duration_ms)
                            ? detail.duration_ms
                            : null,
                        }
                      : null,
    };
  }
  if (item.kind === "assistant_message") {
    const citation = item.memory_citation;
    return {
      ...item,
      phase:
        item.phase === "commentary" || item.phase === "final_answer"
          ? item.phase
          : null,
      memory_citation:
        citation && typeof citation === "object"
          ? {
              entries: Array.isArray(citation.entries)
                ? citation.entries.filter(
                    (entry) =>
                      entry &&
                      typeof entry.path === "string" &&
                      typeof entry.note === "string" &&
                      Number.isSafeInteger(entry.line_start) &&
                      entry.line_start >= 1 &&
                      Number.isSafeInteger(entry.line_end) &&
                      entry.line_end >= entry.line_start,
                  )
                : [],
              thread_ids: Array.isArray(citation.thread_ids)
                ? [
                    ...new Set(
                      citation.thread_ids
                        .filter(
                          (id): id is string =>
                            typeof id === "string" && Boolean(id.trim()),
                        )
                        .map((id) => id.trim()),
                    ),
                  ]
                : [],
            }
          : null,
      citations: Array.isArray(item.citations)
        ? dedupeCitations(
            item.citations.flatMap((citation): ConversationCitation[] => {
              if (
                !citation ||
                typeof citation.kind !== "string" ||
                !citation.kind.trim()
              )
                return [];
              const optionalString = (value: unknown) =>
                typeof value === "string" && value.trim() ? value.trim() : null;
              const locator = normalizeCitationLocator(citation.locator);
              const normalized: ConversationCitation = {
                ...(optionalString(citation.id)
                  ? { id: optionalString(citation.id) }
                  : {}),
                kind: citation.kind.trim(),
                ...(optionalString(citation.url)
                  ? { url: optionalString(citation.url) }
                  : {}),
                ...(optionalString(citation.source)
                  ? { source: optionalString(citation.source) }
                  : {}),
                ...(optionalString(citation.title)
                  ? { title: optionalString(citation.title) }
                  : {}),
                ...(optionalString(citation.cited_text)
                  ? { cited_text: optionalString(citation.cited_text) }
                  : {}),
                ...(locator ? { locator } : {}),
              };
              return normalized.url ||
                normalized.source ||
                normalized.title ||
                normalized.cited_text ||
                normalized.locator
                ? [normalized]
                : [];
            }),
          )
        : [],
      lifecycle: normalizeContentLifecycle(item.lifecycle),
      error: normalizeOptionalString(item.error),
    };
  }
  if (
    item.kind === "reasoning" ||
    item.kind === "code_review" ||
    item.kind === "artifact" ||
    item.kind === "image" ||
    item.kind === "web_search" ||
    item.kind === "unsupported"
  ) {
    return { ...item, lifecycle: normalizeContentLifecycle(item.lifecycle) };
  }
  if (item.kind === "context_compaction") {
    return {
      ...item,
      lifecycle:
        item.lifecycle && TOOL_LIFECYCLES.has(item.lifecycle)
          ? item.lifecycle
          : "unknown",
    };
  }
  if (item.kind === "file_change") {
    return {
      ...item,
      lifecycle:
        item.lifecycle && TOOL_LIFECYCLES.has(item.lifecycle)
          ? item.lifecycle
          : undefined,
      changes: Array.isArray(item.changes)
        ? item.changes.flatMap((change) =>
            change &&
            typeof change.path === "string" &&
            change.path.trim() &&
            typeof change.change_kind === "string" &&
            typeof change.diff === "string"
              ? [
                  {
                    path: change.path,
                    change_kind: change.change_kind,
                    diff: change.diff,
                    move_path:
                      typeof change.move_path === "string" &&
                      change.move_path.trim()
                        ? change.move_path
                        : null,
                  },
                ]
              : [],
          )
        : [],
    };
  }
  return item;
}

function normalizeContentLifecycle(value: unknown): ContentLifecycle {
  return value === "pending" ||
    value === "streaming" ||
    value === "interrupted" ||
    value === "error"
    ? value
    : "complete";
}

/**
 * Older daemons flag any tool whose output mentions the word "permission" as
 * approval-related, which auto-expands the card and splits the transcript's
 * work-session fold — reading a file that contains `permission_mode` was
 * enough. Approval traffic is identified by the tool's own identity, so when
 * neither the title nor the kind mentions approvals/permissions, downgrade the
 * artifact to plain output and let the call fold back into its work session.
 */
function correctMisclassifiedApproval(
  item: Extract<ConversationItem, { kind: "tool_call" }>,
  display: ToolCallDisplay,
): ToolCallDisplay {
  if (
    display.artifact_kind !== "approval_related" &&
    display.activity_kind !== "approval"
  ) {
    return display;
  }
  const identity = `${item.title} ${item.tool_kind}`.toLowerCase();
  if (identity.includes("approval") || identity.includes("permission")) {
    return display;
  }
  // The CLI's own denial phrasing is a genuine approval signal even when the
  // tool identity is a plain command — but a denial always accompanies a
  // failed call, so a successful grep merely quoting the phrase doesn't count.
  if (
    display.is_error &&
    (item.output ?? "").toLowerCase().includes("requested permissions")
  ) {
    return display;
  }
  return {
    ...display,
    activity_kind:
      display.activity_kind === "approval" ? "other" : display.activity_kind,
    artifact_kind:
      display.artifact_kind === "approval_related"
        ? item.output && item.output.trim().length > 0
          ? "command_output"
          : "none"
        : display.artifact_kind,
  };
}

export function normalizeThreadDetail(
  value: ThreadDetail | unknown,
): ThreadDetail {
  const detail = (value ?? {}) as Partial<ThreadDetail>;
  const items = Array.isArray(detail.items)
    ? detail.items.map((item) => normalizeConversationItem(item))
    : [];
  return {
    workspace: normalizeWorkspaceSummary(detail.workspace),
    thread: normalizeThreadSummary(detail.thread),
    items,
    has_older: detail.has_older ?? false,
    oldest_item_id: detail.oldest_item_id ?? items[0]?.id ?? null,
    newest_item_id: detail.newest_item_id ?? items.at(-1)?.id ?? null,
    is_partial: detail.is_partial ?? false,
  };
}

export function normalizeThreadHandle(
  value: ThreadHandle | unknown,
): ThreadHandle {
  const handle = (value ?? {}) as Partial<ThreadHandle>;
  return {
    workspace: normalizeWorkspaceSummary(handle.workspace),
    thread: normalizeThreadSummary(handle.thread),
  };
}

export function normalizeDaemonSnapshot(
  value: DaemonSnapshot | unknown,
): DaemonSnapshot {
  const snapshot = (value ?? {}) as Partial<DaemonSnapshot>;
  const restorePhase: DaemonSnapshot["restore_phase"] =
    snapshot.restore_phase === "loading_persisted_state" ||
    snapshot.restore_phase === "hydrating_workspaces" ||
    snapshot.restore_phase === "ready"
      ? snapshot.restore_phase
      : undefined;
  return {
    daemon: {
      version: snapshot.daemon?.version ?? "unknown",
      started_at: snapshot.daemon?.started_at ?? new Date(0).toISOString(),
      capabilities: {
        scheduled_tasks:
          snapshot.daemon?.capabilities?.scheduled_tasks ?? false,
      },
    },
    ...(restorePhase ? { restore_phase: restorePhase } : {}),
    workspaces: Array.isArray(snapshot.workspaces)
      ? snapshot.workspaces.map((workspace) =>
          normalizeWorkspaceSummary(workspace),
        )
      : [],
    library_workspaces: Array.isArray(snapshot.library_workspaces)
      ? snapshot.library_workspaces.flatMap((workspace) => {
          const normalized = normalizeLibraryWorkspace(workspace);
          return normalized ? [normalized] : [];
        })
      : [],
    threads: Array.isArray(snapshot.threads)
      ? snapshot.threads.map((thread) => normalizeThreadSummary(thread))
      : [],
    interactive_requests: Array.isArray(snapshot.interactive_requests)
      ? snapshot.interactive_requests.flatMap((request) => {
          const normalized = normalizeInteractiveRequest(request);
          return normalized ? [normalized] : [];
        })
      : [],
    service_notices: Array.isArray(snapshot.service_notices)
      ? snapshot.service_notices.filter(
          (notice) =>
            notice &&
            typeof notice.id === "string" &&
            typeof notice.workspace_id === "string" &&
            (notice.level === "info" ||
              notice.level === "warning" ||
              notice.level === "error") &&
            typeof notice.message === "string" &&
            typeof notice.created_at === "string",
        )
      : [],
    operational_conditions: Array.isArray(snapshot.operational_conditions)
      ? snapshot.operational_conditions.filter(
          (condition) =>
            condition &&
            typeof condition.id === "string" &&
            typeof condition.key === "string" &&
            typeof condition.workspace_id === "string" &&
            (condition.level === "info" ||
              condition.level === "warning" ||
              condition.level === "error") &&
            typeof condition.message === "string" &&
            typeof condition.created_at === "string" &&
            typeof condition.updated_at === "string",
        )
      : [],
    thread_token_usage: Object.fromEntries(
      Object.entries(snapshot.thread_token_usage ?? {}).flatMap(
        ([threadId, usage]) => {
          const normalized = normalizeThreadTokenUsage(usage);
          return normalized ? [[threadId, normalized]] : [];
        },
      ),
    ),
    preferences: normalizePreferences(snapshot.preferences),
    extensions: normalizeExtensionSnapshot(snapshot.extensions),
    scheduled_tasks: Array.isArray(snapshot.scheduled_tasks)
      ? snapshot.scheduled_tasks.flatMap((task) => {
          const normalized = normalizeScheduledTask(task);
          return normalized ? [normalized] : [];
        })
      : [],
  };
}

export function normalizeExtensionSnapshot(value: unknown): ExtensionSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { catalog: [], views: [] };
  }
  const snapshot = value as Record<string, unknown>;
  const normalizeId = (candidate: unknown) =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= 512
      ? candidate
      : null;
  const normalizeContributions = (candidate: unknown) => {
    const contributions =
      candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>)
        : {};
    const actions = Array.isArray(contributions.threadMenuActions)
      ? contributions.threadMenuActions.flatMap((candidate) => {
          if (
            !candidate ||
            typeof candidate !== "object" ||
            Array.isArray(candidate)
          )
            return [];
          const action = candidate as Record<string, unknown>;
          const id = normalizeId(action.id);
          return id && typeof action.title === "string"
            ? [{ id, title: action.title }]
            : [];
        })
      : [];
    const normalizeViews = (candidate: unknown) =>
      Array.isArray(candidate)
        ? candidate.flatMap((candidate) => {
            if (
              !candidate ||
              typeof candidate !== "object" ||
              Array.isArray(candidate)
            )
              return [];
            const view = candidate as Record<string, unknown>;
            const id = normalizeId(view.id);
            const viewId = normalizeId(view.view);
            const icon =
              typeof view.icon === "string" &&
              /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(view.icon)
                ? view.icon
                : undefined;
            const normalizedUi = normalizeExtensionUiDocument(view.ui);
            // A null `ui` is what this function emits for a contribution that
            // declared none, so it has to read as "no UI" and not as a
            // malformed document — otherwise re-normalizing our own output
            // invents an unsupported reason and blocks rendering.
            const hasUi =
              Object.hasOwn(view, "ui") &&
              view.ui !== null &&
              view.ui !== undefined;
            return id && viewId
              ? [
                  {
                    id,
                    view: viewId,
                    title:
                      typeof view.title === "string" ? view.title : undefined,
                    icon,
                    ui: normalizedUi.ok ? normalizedUi.document : null,
                    uiUnsupportedReason:
                      hasUi && !normalizedUi.ok ? normalizedUi.reason : null,
                  },
                ]
              : [];
          })
        : [];
    const normalizeAgentTools = (candidate: unknown) =>
      Array.isArray(candidate)
        ? candidate.flatMap((candidate) => {
            if (
              !candidate ||
              typeof candidate !== "object" ||
              Array.isArray(candidate)
            )
              return [];
            const tool = candidate as Record<string, unknown>;
            const id = normalizeId(tool.id);
            return id &&
              typeof tool.title === "string" &&
              typeof tool.description === "string"
              ? [{ id, title: tool.title, description: tool.description }]
              : [];
          })
        : [];
    const knownKinds = new Set([
      "threadMenuActions",
      "panelActions",
      "threadDecorations",
      "sidebarFilters",
      "panels",
      "composerSuggestions",
      "agentTools",
      // `unsupported` is this function's own output key. Snapshots get
      // normalized more than once on their way to the UI, so treating it as an
      // unknown kind would make the second pass report our own bookkeeping as
      // an unrenderable contribution.
      "unsupported",
    ]);
    const carriedUnsupported = Array.isArray(contributions.unsupported)
      ? contributions.unsupported.flatMap((candidate) => {
          if (
            !candidate ||
            typeof candidate !== "object" ||
            Array.isArray(candidate)
          )
            return [];
          const entry = candidate as Record<string, unknown>;
          return typeof entry.kind === "string" &&
            entry.kind.length > 0 &&
            Array.isArray(entry.entries)
            ? [{ kind: entry.kind, entries: entry.entries }]
            : [];
        })
      : [];
    const unsupported = [
      ...carriedUnsupported,
      ...Object.entries(contributions).flatMap(([kind, entries]) =>
        !knownKinds.has(kind) && Array.isArray(entries)
          ? [{ kind, entries }]
          : [],
      ),
    ].filter(
      (contribution, index, all) =>
        // An empty entry list has nothing for a client to render, so warning
        // about it would be noise.
        contribution.entries.length > 0 &&
        all.findIndex((other) => other.kind === contribution.kind) === index,
    );
    return {
      threadMenuActions: actions,
      panelActions: Array.isArray(contributions.panelActions)
        ? contributions.panelActions.flatMap((candidate) => {
            if (
              !candidate ||
              typeof candidate !== "object" ||
              Array.isArray(candidate)
            )
              return [];
            const action = candidate as Record<string, unknown>;
            const id = normalizeId(action.id);
            return id && typeof action.title === "string"
              ? [{ id, title: action.title }]
              : [];
          })
        : [],
      threadDecorations: normalizeViews(contributions.threadDecorations),
      sidebarFilters: normalizeViews(contributions.sidebarFilters),
      panels: normalizeViews(contributions.panels),
      composerSuggestions: normalizeViews(contributions.composerSuggestions),
      agentTools: normalizeAgentTools(contributions.agentTools),
      unsupported,
    };
  };
  return {
    catalog: Array.isArray(snapshot.catalog)
      ? snapshot.catalog.flatMap((candidate) => {
          if (
            !candidate ||
            typeof candidate !== "object" ||
            Array.isArray(candidate)
          )
            return [];
          const extension = candidate as Record<string, unknown>;
          const id = normalizeId(extension.id);
          if (
            !id ||
            typeof extension.name !== "string" ||
            typeof extension.version !== "string"
          ) {
            return [];
          }
          const status =
            extension.status === "active" || extension.status === "error"
              ? extension.status
              : "disabled";
          return [
            {
              id,
              name: extension.name,
              version: extension.version,
              source:
                typeof extension.source === "string"
                  ? extension.source
                  : "unknown",
              bundled: extension.bundled === true,
              enabled: extension.enabled === true,
              status,
              last_error:
                typeof extension.last_error === "string"
                  ? extension.last_error
                  : null,
              contributes: normalizeContributions(extension.contributes),
              permissions: Array.isArray(extension.permissions)
                ? extension.permissions.filter(
                    (permission): permission is string =>
                      typeof permission === "string",
                  )
                : [],
              granted_permissions: Array.isArray(extension.granted_permissions)
                ? extension.granted_permissions.filter(
                    (permission): permission is string =>
                      typeof permission === "string",
                  )
                : [],
            },
          ];
        })
      : [],
    views: Array.isArray(snapshot.views)
      ? snapshot.views.flatMap((candidate) => {
          if (
            !candidate ||
            typeof candidate !== "object" ||
            Array.isArray(candidate)
          )
            return [];
          const view = candidate as Record<string, unknown>;
          const extensionId = normalizeId(view.extension_id);
          const viewId = normalizeId(view.view_id);
          if (!extensionId || !viewId || typeof view.updated_at !== "string")
            return [];
          const rawScope = view.scope;
          const scope =
            rawScope && typeof rawScope === "object" && !Array.isArray(rawScope)
              ? (rawScope as Record<string, unknown>)
              : null;
          const kind = normalizeId(scope?.kind);
          const id = normalizeId(scope?.id);
          if (rawScope != null && (!kind || !id)) return [];
          return [
            {
              extension_id: extensionId,
              view_id: viewId,
              scope: kind && id ? { kind, id } : null,
              value: view.value,
              updated_at: view.updated_at,
            },
          ];
        })
      : [],
  };
}

export function normalizeThreadTokenUsage(
  value: unknown,
): ThreadTokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<ThreadTokenUsage>;
  if (!raw.total || typeof raw.total !== "object") return null;
  const normalizeBreakdown = (breakdown: unknown) => {
    const counts = (breakdown ?? {}) as Record<string, unknown>;
    const count = (key: string) =>
      typeof counts[key] === "number" &&
      Number.isFinite(counts[key]) &&
      (counts[key] as number) >= 0
        ? (counts[key] as number)
        : 0;
    return {
      total_tokens: count("total_tokens"),
      input_tokens: count("input_tokens"),
      cached_input_tokens: count("cached_input_tokens"),
      output_tokens: count("output_tokens"),
      reasoning_output_tokens: count("reasoning_output_tokens"),
    };
  };
  return {
    total: normalizeBreakdown(raw.total),
    last:
      raw.last && typeof raw.last === "object"
        ? normalizeBreakdown(raw.last)
        : null,
    model_context_window:
      typeof raw.model_context_window === "number" &&
      Number.isFinite(raw.model_context_window)
        ? raw.model_context_window
        : null,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
  };
}

export function normalizeEventEnvelope(
  value: EventEnvelope | unknown,
): EventEnvelope {
  if (
    value !== null &&
    typeof value === "object" &&
    normalizedEventEnvelopes.has(value)
  ) {
    return value as EventEnvelope;
  }

  const envelope = (value ?? {}) as Partial<EventEnvelope>;
  const event = envelope.event;

  const markNormalized = (normalized: EventEnvelope) => {
    if (normalized !== null && typeof normalized === "object") {
      normalizedEventEnvelopes.add(normalized);
    }
    return normalized;
  };

  if (event?.type === "snapshot") {
    return markNormalized({
      ...(envelope as EventEnvelope),
      event: {
        ...event,
        snapshot: normalizeDaemonSnapshot(event.snapshot),
      },
    });
  }

  if (event?.type === "thread-started" || event?.type === "thread-updated") {
    return markNormalized({
      ...(envelope as EventEnvelope),
      event: {
        ...event,
        thread: normalizeThreadSummary(event.thread),
      },
    });
  }

  if (event?.type === "workspace-updated") {
    return markNormalized({
      ...(envelope as EventEnvelope),
      event: {
        ...event,
        workspace: normalizeWorkspaceSummary(event.workspace),
      },
    });
  }

  if (
    event?.type === "conversation-item-added" ||
    event?.type === "conversation-item-updated"
  ) {
    return markNormalized({
      ...(envelope as EventEnvelope),
      event: {
        ...event,
        item: normalizeConversationItem(event.item),
      },
    });
  }

  if (event?.type === "control-state-changed") {
    return markNormalized({
      ...(envelope as EventEnvelope),
      event: {
        ...event,
        change: normalizeControlStateChanged(event.change) ?? event.change,
      },
    });
  }

  if (event?.type === "preferences-updated") {
    return markNormalized({
      ...(envelope as EventEnvelope),
      event: {
        ...event,
        preferences: normalizePreferences(event.preferences),
      },
    });
  }

  if (event?.type === "extension-catalog-updated") {
    return markNormalized({
      ...(envelope as EventEnvelope),
      event: {
        ...event,
        catalog: normalizeExtensionSnapshot({
          catalog: event.catalog,
          views: [],
        }).catalog,
      },
    });
  }

  if (
    event?.type === "scheduled-task-created" ||
    event?.type === "scheduled-task-updated"
  ) {
    const task = normalizeScheduledTask(event.task);
    return markNormalized({
      ...(envelope as EventEnvelope),
      event: { ...event, task: task ?? event.task },
    });
  }

  if (
    event?.type === "scheduled-task-run-started" ||
    event?.type === "scheduled-task-run-updated"
  ) {
    const run = normalizeScheduledTaskRun(event.run);
    return markNormalized({
      ...(envelope as EventEnvelope),
      event: { ...event, run: run ?? event.run },
    });
  }

  if (event?.type === "extension-view-updated") {
    const view = event.view
      ? (normalizeExtensionSnapshot({ catalog: [], views: [event.view] })
          .views[0] ?? null)
      : null;
    return markNormalized({
      ...(envelope as EventEnvelope),
      event: { ...event, view },
    });
  }

  if (event?.type === "thread-token-usage-updated") {
    const usage = normalizeThreadTokenUsage(event.usage);
    return markNormalized(
      usage
        ? ({
            ...(envelope as EventEnvelope),
            event: { ...event, usage },
          } as EventEnvelope)
        : (envelope as EventEnvelope),
    );
  }

  if (event?.type === "service" && event.notice) {
    const notice = event.notice;
    if (
      typeof notice.id !== "string" ||
      typeof notice.workspace_id !== "string" ||
      (notice.level !== "info" &&
        notice.level !== "warning" &&
        notice.level !== "error") ||
      typeof notice.message !== "string" ||
      typeof notice.created_at !== "string"
    ) {
      return markNormalized({
        ...(envelope as EventEnvelope),
        event: { ...event, notice: null },
      });
    }
  }

  return markNormalized(envelope as EventEnvelope);
}

export function normalizeToolCallDisplay(value: unknown): ToolCallDisplay {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_TOOL_CALL_DISPLAY };
  }

  const display = value as Partial<ToolCallDisplay>;
  const artifactKind =
    display.artifact_kind === "diff" ||
    display.artifact_kind === "test" ||
    display.artifact_kind === "command_output" ||
    display.artifact_kind === "approval_related"
      ? display.artifact_kind
      : "none";
  const activityKind =
    display.activity_kind === "read" ||
    display.activity_kind === "search" ||
    display.activity_kind === "list" ||
    display.activity_kind === "command" ||
    display.activity_kind === "edit" ||
    display.activity_kind === "test" ||
    display.activity_kind === "approval" ||
    display.activity_kind === "diff" ||
    display.activity_kind === "web_search" ||
    display.activity_kind === "image_view" ||
    display.activity_kind === "context"
      ? display.activity_kind
      : "other";
  const historyMode = display.history_mode === "summary" ? "summary" : "full";
  const lifecycle: ToolLifecycle | undefined =
    display.lifecycle === "unknown" ||
    display.lifecycle === "queued" ||
    display.lifecycle === "awaiting_approval" ||
    display.lifecycle === "running" ||
    display.lifecycle === "succeeded" ||
    display.lifecycle === "failed" ||
    display.lifecycle === "denied" ||
    display.lifecycle === "interrupted"
      ? display.lifecycle
      : undefined;

  return {
    is_read_only: display.is_read_only ?? false,
    has_side_effect: display.has_side_effect ?? false,
    is_error: display.is_error ?? false,
    lifecycle,
    artifact_kind: artifactKind,
    activity_kind: activityKind,
    history_mode: historyMode,
    summary_hint:
      typeof display.summary_hint === "string" &&
      display.summary_hint.trim().length > 0
        ? display.summary_hint
        : null,
    test_summary: normalizeToolTestSummary(display.test_summary),
    provider_output_summary: normalizeToolProviderOutputSummary(
      display.provider_output_summary,
    ),
  };
}

function normalizeToolProviderOutputSummary(
  value: unknown,
): ToolCallDisplay["provider_output_summary"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = value as Record<string, unknown>;
  const fields = [
    "text_blocks",
    "images",
    "audio",
    "resource_links",
    "embedded_resources",
    "structured_results",
  ] as const;
  const normalized = Object.fromEntries(
    fields.map((field) => [field, summary[field]]),
  ) as Record<(typeof fields)[number], unknown>;
  if (
    fields.some(
      (field) =>
        typeof normalized[field] !== "number" ||
        !Number.isSafeInteger(normalized[field]) ||
        (normalized[field] as number) < 0,
    )
  ) {
    return null;
  }
  return normalized as NonNullable<ToolCallDisplay["provider_output_summary"]>;
}

function normalizeToolTestSummary(
  value: unknown,
): ToolCallDisplay["test_summary"] {
  if (!value || typeof value !== "object") return null;
  const summary = value as Record<string, unknown>;
  const count = (field: string) => {
    const candidate = summary[field];
    return typeof candidate === "number" &&
      Number.isSafeInteger(candidate) &&
      candidate >= 0
      ? candidate
      : null;
  };
  const normalized = {
    framework:
      typeof summary.framework === "string" &&
      summary.framework.trim().length > 0
        ? summary.framework.trim()
        : null,
    total: count("total"),
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
    suites_total: count("suites_total"),
    suites_passed: count("suites_passed"),
    suites_failed: count("suites_failed"),
    duration_ms: count("duration_ms"),
  };
  return Object.values(normalized).some((entry) => entry != null)
    ? normalized
    : null;
}

export function normalizePreferences(value: unknown): FalconDeckPreferences {
  if (!value || typeof value !== "object") {
    return {
      ...DEFAULT_PREFERENCES,
      conversation: {
        ...DEFAULT_CONVERSATION_PREFERENCES,
        auto_expand: { ...DEFAULT_CONVERSATION_PREFERENCES.auto_expand },
      },
      utility_models: normalizeUtilityModelPreferences(undefined),
    };
  }

  const raw = value as Partial<FalconDeckPreferences>;
  const conversation = (raw.conversation ??
    {}) as Partial<ConversationPreferences>;
  const notifications = (raw.notifications ?? {}) as Partial<
    FalconDeckPreferences["notifications"]
  >;
  const autoExpand = (conversation.auto_expand ?? {}) as Partial<
    ConversationPreferences["auto_expand"]
  >;

  const toolDetailsMode =
    conversation.tool_details_mode === "collapsed" ||
    conversation.tool_details_mode === "auto" ||
    conversation.tool_details_mode === "expanded" ||
    conversation.tool_details_mode === "compact" ||
    conversation.tool_details_mode === "hide_read_only_details"
      ? conversation.tool_details_mode
      : "collapsed";

  const thinkingDisplay =
    conversation.thinking_display === "preview" ||
    conversation.thinking_display === "always_expanded" ||
    conversation.thinking_display === "always_collapsed"
      ? conversation.thinking_display
      : "auto";

  const workspaceOrder = Array.isArray(raw.workspace_order)
    ? raw.workspace_order.reduce<string[]>((ordered, workspaceId) => {
        if (typeof workspaceId !== "string") return ordered;
        const normalizedId = workspaceId.trim();
        if (normalizedId && !ordered.includes(normalizedId))
          ordered.push(normalizedId);
        return ordered;
      }, [])
    : [];

  return {
    version:
      typeof raw.version === "number" && Number.isFinite(raw.version)
        ? raw.version
        : 1,
    workspace_order: workspaceOrder,
    workspace_colors: normalizeWorkspaceColors(raw.workspace_colors),
    conversation: {
      tool_details_mode: toolDetailsMode,
      auto_expand: {
        approvals: autoExpand.approvals ?? true,
        errors: autoExpand.errors ?? true,
        first_diff: autoExpand.first_diff ?? true,
        failed_tests: autoExpand.failed_tests ?? true,
      },
      group_read_only_tools: conversation.group_read_only_tools ?? true,
      show_expand_all_controls: conversation.show_expand_all_controls ?? true,
      thinking_display: thinkingDisplay,
      collapse_long_user_messages:
        conversation.collapse_long_user_messages ?? true,
    },
    notifications: {
      enabled: notifications.enabled ?? true,
      notify_on_turn_complete: notifications.notify_on_turn_complete ?? true,
      notify_on_input_required: notifications.notify_on_input_required ?? true,
      notify_on_error: notifications.notify_on_error ?? true,
      suppress_when_desktop_active:
        notifications.suppress_when_desktop_active ?? true,
    },
    utility_models: normalizeUtilityModelPreferences(raw.utility_models),
  };
}

/** Older daemons omit utility models entirely, so an absent or malformed
 * section falls back to the shipped chain rather than disabling background
 * titles. */
function normalizeUtilityModelPreferences(
  value: unknown,
): UtilityModelPreferences {
  const raw = (value ?? {}) as Partial<UtilityModelPreferences>;
  const providerOrder = Array.isArray(raw.provider_order)
    ? raw.provider_order.reduce<string[]>((ordered, provider) => {
        if (typeof provider !== "string") return ordered;
        const normalized = provider.trim();
        if (normalized && !ordered.includes(normalized))
          ordered.push(normalized);
        return ordered;
      }, [])
    : [];
  const models = Array.isArray(raw.models)
    ? raw.models.reduce<UtilityModelChoice[]>((choices, choice) => {
        if (!choice || typeof choice !== "object") return choices;
        const entry = choice as Partial<UtilityModelChoice>;
        const provider =
          typeof entry.provider === "string" ? entry.provider.trim() : "";
        if (
          !provider ||
          choices.some((existing) => existing.provider === provider)
        )
          return choices;
        choices.push({
          provider,
          model_id:
            typeof entry.model_id === "string" ? entry.model_id.trim() : "",
        });
        return choices;
      }, [])
    : [...DEFAULT_UTILITY_MODEL_PREFERENCES.models];
  return {
    provider_order: providerOrder.length
      ? providerOrder
      : [...DEFAULT_UTILITY_PROVIDER_ORDER],
    models,
  };
}

const HARNESS_KINDS = new Set(["builtin", "acp", "detected"]);
const HARNESS_EXECUTABLE_SOURCES = new Set([
  "configured",
  "path",
  "known_location",
  "login_shell",
  "unknown",
]);
const HARNESS_VERSION_STATES = new Set([
  "detected",
  "current",
  "update_available",
  "unavailable",
]);
const HARNESS_AUTH_VERDICTS = new Set([
  "authenticated",
  "unauthenticated",
  "unavailable",
  "unsupported",
]);
const HARNESS_COMPATIBILITY_VERDICTS = new Set([
  "compatible",
  "incompatible",
  "unknown",
  "unsupported",
]);
const HARNESS_PROVIDER_USAGE_STATES = new Set([
  "supported",
  "unavailable",
  "unsupported",
]);
const USAGE_CAPABLE_HARNESSES = new Set([
  "codex",
  "claude",
  "grok",
  "cursor",
  "agy",
]);
const HARNESS_UPGRADE_STATUSES = new Set(["running", "completed", "failed"]);

function optionalTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/** Normalizes one harness entry, tolerating partial daemon responses. */
export function normalizeHarnessSummary(value: unknown): HarnessSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const bin = typeof raw.bin === "string" ? raw.bin.trim() : "";
  if (!id || !bin) return null;
  const kind = HARNESS_KINDS.has(String(raw.kind))
    ? (raw.kind as HarnessSummary["kind"])
    : "detected";
  const installed = raw.installed === true;
  const version = optionalTrimmedString(raw.version);
  const latestVersion = optionalTrimmedString(raw.latest_version);
  const updateAvailable =
    typeof raw.update_available === "boolean" ? raw.update_available : null;
  const inferredVersionState = !version
    ? "unavailable"
    : !latestVersion || updateAvailable === null
      ? "detected"
      : updateAvailable
        ? "update_available"
        : "current";
  return {
    id,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label : id,
    kind,
    bin,
    resolved_path: optionalTrimmedString(raw.resolved_path),
    installed,
    install_state:
      raw.install_state === "installed" || raw.install_state === "missing"
        ? raw.install_state
        : installed
          ? "installed"
          : "missing",
    executable_source: HARNESS_EXECUTABLE_SOURCES.has(
      String(raw.executable_source),
    )
      ? (raw.executable_source as HarnessSummary["executable_source"])
      : "unknown",
    version,
    latest_version: latestVersion,
    update_available: updateAvailable,
    version_state: HARNESS_VERSION_STATES.has(String(raw.version_state))
      ? (raw.version_state as HarnessSummary["version_state"])
      : inferredVersionState,
    install_source: optionalTrimmedString(raw.install_source),
    upgrade_command: optionalTrimmedString(raw.upgrade_command),
    account_status: optionalTrimmedString(raw.account_status),
    auth_verdict: HARNESS_AUTH_VERDICTS.has(String(raw.auth_verdict))
      ? (raw.auth_verdict as HarnessSummary["auth_verdict"])
      : "unsupported",
    compatibility_verdict: HARNESS_COMPATIBILITY_VERDICTS.has(
      String(raw.compatibility_verdict),
    )
      ? (raw.compatibility_verdict as HarnessSummary["compatibility_verdict"])
      : "unknown",
    provider_usage_state: HARNESS_PROVIDER_USAGE_STATES.has(
      String(raw.provider_usage_state),
    )
      ? (raw.provider_usage_state as HarnessSummary["provider_usage_state"])
      : USAGE_CAPABLE_HARNESSES.has(id)
        ? installed
          ? "supported"
          : "unavailable"
        : "unsupported",
    last_checked_at: optionalTrimmedString(raw.last_checked_at),
    failure: optionalTrimmedString(raw.failure),
  };
}

/** Normalizes the `GET/POST /api/harnesses(…/refresh)` response body. */
export function normalizeHarnessesOverview(value: unknown): HarnessesOverview {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { host: "local", harnesses: [] };
  }
  const raw = value as Record<string, unknown>;
  const host =
    typeof raw.host === "string" && raw.host.trim() ? raw.host.trim() : "local";
  const harnesses = Array.isArray(raw.harnesses)
    ? raw.harnesses.flatMap((entry) => {
        const normalized = normalizeHarnessSummary(entry);
        return normalized ? [normalized] : [];
      })
    : [];
  return { host, harnesses };
}

/** Normalizes a harness upgrade job status body. */
export function normalizeHarnessUpgradeJob(
  value: unknown,
): HarnessUpgradeJob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const jobId = typeof raw.job_id === "string" ? raw.job_id.trim() : "";
  const harnessId =
    typeof raw.harness_id === "string" ? raw.harness_id.trim() : "";
  if (!jobId || !harnessId) return null;
  return {
    job_id: jobId,
    harness_id: harnessId,
    label:
      typeof raw.label === "string" && raw.label.trim() ? raw.label : harnessId,
    host:
      typeof raw.host === "string" && raw.host.trim()
        ? raw.host.trim()
        : "local",
    status: HARNESS_UPGRADE_STATUSES.has(String(raw.status))
      ? (raw.status as HarnessUpgradeJob["status"])
      : "running",
    log: Array.isArray(raw.log)
      ? raw.log.filter((line): line is string => typeof line === "string")
      : [],
    error: optionalTrimmedString(raw.error),
  };
}
