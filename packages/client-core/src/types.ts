export type WorkspaceStatus =
  "connecting" | "ready" | "needs_auth" | "busy" | "disconnected" | "error";

/**
 * Provider id as sent by the daemon. Open-ended on purpose: the daemon can
 * register providers we have never heard of (ACP-configured CLIs), so this is a
 * plain string and unknown ids must survive round-tripping.
 */
export type AgentProvider = string;

/** Providers with first-class support in the clients (icons, copy, defaults). */
export const KNOWN_PROVIDERS = ["codex", "claude"] as const;
export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];
export type ThreadStatus = "idle" | "running" | "waiting_for_input" | "error";
export type ServiceLevel = "info" | "warning" | "error";
export type ThreadAttentionLevel =
  "none" | "unread" | "running" | "awaiting_response" | "error";

export type ReasoningEffortOption = {
  reasoning_effort: string;
  description: string;
};

/**
 * A service tier a model can run on beyond the provider's standard tier
 * (Codex fast mode advertises `{id: "priority", name: "Fast"}`). `id` is what
 * turn requests carry back; `name`/`description` are display copy.
 */
export type ServiceTierOption = {
  id: string;
  name: string;
  description: string;
};

export type ModelSummary = {
  id: string;
  label: string;
  is_default: boolean;
  default_reasoning_effort: string | null;
  supported_reasoning_efforts: ReasoningEffortOption[];
  /** Extra service tiers; absent/empty hides the speed toggle. Optional because older daemons omit it. */
  service_tiers?: ServiceTierOption[];
  default_service_tier?: string | null;
};

export type CollaborationModeSummary = {
  id: string;
  label: string;
  mode?: string | null;
  model_id: string | null;
  reasoning_effort: string | null;
  is_native?: boolean;
};

export type AccountSummary = {
  status: "unknown" | "ready" | "needs_auth";
  label: string;
};

/** USD-cent spend figures for a usage-metered plan window. */
export type ProviderUsageCost = {
  used_usd_cents: number;
  limit_usd_cents: number;
};

/**
 * One usage window in a provider subscription snapshot, e.g. the rolling
 * five-hour session limit or the weekly limit.
 */
export type ProviderUsageWindow = {
  label: string;
  /** Used share of the window, normalized to 0-100. */
  used_percent: number;
  /** ISO-8601 timestamp when the window resets, when the provider reports one. */
  resets_at: string | null;
  /** Optional spend figures for usage-metered plans (USD cents). */
  cost?: ProviderUsageCost | null;
};

/**
 * Live usage snapshot for one provider subscription. Discriminated on
 * `status` so clients can render the windows, a sign-in hint, or an error
 * without inventing placeholder numbers.
 */
export type ProviderUsage =
  | {
      status: "ok";
      account_email: string | null;
      plan_label: string | null;
      windows: ProviderUsageWindow[];
    }
  | { status: "not_installed" }
  | { status: "unauthenticated" }
  | { status: "expired" }
  | {
      status: "error";
      message: string;
      /** Plan/account known from local auth state before the call, if any. */
      plan_label?: string | null;
      account_email?: string | null;
    };

/** Response for the provider usage endpoints; each provider resolves independently. */
export type ProviderUsageOverview = {
  codex: ProviderUsage;
  claude_code: ProviderUsage;
};

export type AgentCapabilitySummary = {
  supports_review: boolean;
  supports_goals: boolean;
  supports_images: boolean;
  supports_skills: boolean;
  supports_interrupt: boolean;
  /** Whether a message can be injected into a running turn to redirect it. */
  supports_steering: boolean;
  /** Whether the provider can branch history at a completed turn boundary. */
  supports_forking: boolean;
  /** Sandbox modes the provider accepts; empty hides the sandbox picker. */
  sandbox_modes: string[];
  /** Permission modes the provider accepts; empty hides the picker. */
  permission_modes: string[];
};

export type SkillAvailability = "codex" | "claude" | "both";
export type SkillSourceKind = "provider_native" | "project_file" | "home_file";

export type CodexSkillTranslation = {
  native_id?: string | null;
  native_name?: string | null;
};

export type ClaudeSkillTranslation = {
  command_name?: string | null;
  prompt_reference_path?: string | null;
};

export type OpenCodeSkillTranslation = {
  /** Inline `$name` mention OpenCode expands by loading the SKILL.md. */
  native_name?: string | null;
};

export type SkillProviderTranslations = {
  codex?: CodexSkillTranslation | null;
  claude?: ClaudeSkillTranslation | null;
  opencode?: OpenCodeSkillTranslation | null;
};

export type SkillSummary = {
  id: string;
  label: string;
  alias: string;
  /** Legacy two-provider projection; prefer `providers`. */
  availability: SkillAvailability;
  /** Open list of provider ids that can use this skill. */
  providers: AgentProvider[];
  source_kind: SkillSourceKind;
  source_path?: string | null;
  description?: string | null;
  provider_translations?: SkillProviderTranslations | null;
};

export type WorkspaceAgentSummary = {
  provider: AgentProvider;
  /** Human-readable provider name for pickers. */
  label: string;
  account: AccountSummary;
  models: ModelSummary[];
  collaboration_modes: CollaborationModeSummary[];
  skills?: SkillSummary[];
  capabilities?: AgentCapabilitySummary;
};

/** How FalconDeck knows about a coding harness (agent CLI). */
export type HarnessKind = "builtin" | "acp" | "detected";

/**
 * Install status of one coding harness on one host (local machine or an SSH
 * target). Latest-version fields are only populated after an explicit
 * refresh with update checks enabled.
 */
export type HarnessSummary = {
  id: string;
  label: string;
  kind: HarnessKind;
  /** Binary name the daemon resolves and launches. */
  bin: string;
  resolved_path?: string | null;
  installed?: boolean;
  version?: string | null;
  latest_version?: string | null;
  update_available?: boolean | null;
  /** Best-effort install classification (npm/homebrew/cargo/local/unknown). */
  install_source?: string | null;
  /** Command FalconDeck can run to install/upgrade, when managed. */
  upgrade_command?: string | null;
  /** Auth/subscription state line reported by the harness, when probed. */
  account_status?: string | null;
};

/** Response for the harness overview endpoints. */
export type HarnessesOverview = {
  /** Host the statuses describe: "local" or the SSH target. */
  host: string;
  harnesses: HarnessSummary[];
};

/** Request body for `POST /api/harnesses/refresh`. */
export type HarnessRefreshRequest = {
  ssh_target?: string | null;
  port?: number | null;
  /** Also look up latest published versions (network). Defaults to true. */
  include_latest?: boolean;
};

/** Request body for `POST /api/harnesses/upgrade`. */
export type HarnessUpgradeRequest = {
  harness_id: string;
  ssh_target?: string | null;
  port?: number | null;
};

export type HarnessUpgradeStatus = "running" | "completed" | "failed";

/** Install/upgrade job state, polled by the settings panel. */
export type HarnessUpgradeJob = {
  job_id: string;
  harness_id: string;
  label: string;
  /** Host the job runs on: "local" or the SSH target. */
  host: string;
  status: HarnessUpgradeStatus;
  log: string[];
  error?: string | null;
};

export type ThreadAgentParams = {
  model_id: string | null;
  reasoning_effort: string | null;
  collaboration_mode_id: string | null;
  approval_policy: string | null;
  service_tier: string | null;
  permission_mode?: string | null;
  sandbox_mode?: string | null;
};

export type ThreadGoal = {
  objective: string;
  status: string;
  token_budget?: number | null;
  tokens_used?: number | null;
  time_used_seconds?: number | null;
  /** RFC 3339 timestamp of when the goal was started (daemon-stamped). */
  started_at?: string | null;
};

export type ToolDetailsMode =
  "collapsed" | "auto" | "expanded" | "compact" | "hide_read_only_details";

/**
 * How reasoning/thinking blocks reveal themselves, copied from Zed's four-value
 * setting. `auto` follows the stream — expanded while the thought arrives, then
 * collapsed once it ends unless the reader has toggled it. `preview` keeps a
 * height-capped excerpt visible that a click promotes to the full text.
 */
export type ThinkingDisplay =
  "auto" | "preview" | "always_expanded" | "always_collapsed";

export type ConversationAutoExpandPreferences = {
  approvals: boolean;
  errors: boolean;
  first_diff: boolean;
  failed_tests: boolean;
};

export type ConversationPreferences = {
  tool_details_mode: ToolDetailsMode;
  auto_expand: ConversationAutoExpandPreferences;
  group_read_only_tools: boolean;
  show_expand_all_controls: boolean;
  thinking_display: ThinkingDisplay;
};

export type NotificationPreferences = {
  enabled: boolean;
  notify_on_turn_complete: boolean;
  notify_on_input_required: boolean;
  notify_on_error: boolean;
  suppress_when_desktop_active: boolean;
};

/** A provider-scoped model used for FalconDeck's own background work. */
export type UtilityModelChoice = {
  provider: string;
  /** Empty means "use the provider's own default model". */
  model_id: string;
};

export type UtilityModelPreferences = {
  /** Providers tried in order; the first installed and ready one wins. */
  provider_order: string[];
  models: UtilityModelChoice[];
};

export type FalconDeckPreferences = {
  version: number;
  /** Older daemons omit this until project order has been saved. */
  workspace_order?: string[];
  /**
   * Sidebar folder colors keyed by workspace id. Values are categorical
   * tokens (`cat-1`…`cat-12`) so they retint with the active theme.
   */
  workspace_colors?: Record<string, string>;
  conversation: ConversationPreferences;
  notifications: NotificationPreferences;
  /** Older daemons omit this; `normalizePreferences` always fills it in. */
  utility_models?: UtilityModelPreferences;
};

export type UpdateConversationAutoExpandPreferences =
  Partial<ConversationAutoExpandPreferences>;

export type UpdateConversationPreferences = {
  tool_details_mode?: ToolDetailsMode | null;
  auto_expand?: UpdateConversationAutoExpandPreferences | null;
  group_read_only_tools?: boolean | null;
  show_expand_all_controls?: boolean | null;
  thinking_display?: ThinkingDisplay | null;
};

export type UpdateNotificationPreferences = Partial<NotificationPreferences>;

export type UpdateUtilityModelPreferences = {
  provider_order?: string[] | null;
  models?: UtilityModelChoice[] | null;
};

export type UpdatePreferencesPayload = {
  workspace_order?: string[] | null;
  workspace_colors?: Record<string, string> | null;
  conversation?: UpdateConversationPreferences | null;
  notifications?: UpdateNotificationPreferences | null;
  utility_models?: UpdateUtilityModelPreferences | null;
};

export type ToolArtifactKind =
  "none" | "diff" | "test" | "command_output" | "approval_related";
export type ToolActivityKind =
  | "read"
  | "search"
  | "list"
  | "command"
  | "edit"
  | "test"
  | "approval"
  | "diff"
  | "web_search"
  | "image_view"
  | "context"
  | "other";
export type ToolHistoryMode = "summary" | "full";
export type ToolLifecycle =
  | "unknown"
  | "queued"
  | "awaiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "denied"
  | "interrupted";
export type ContentLifecycle =
  "pending" | "streaming" | "complete" | "interrupted" | "error";

export type ToolTestSummary = {
  framework: string | null;
  total: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  suites_total: number | null;
  suites_passed: number | null;
  suites_failed: number | null;
  duration_ms: number | null;
};

export type ToolProviderOutputSummary = {
  text_blocks: number;
  images: number;
  audio: number;
  resource_links: number;
  embedded_resources: number;
  structured_results: number;
};

export type ToolCallDisplay = {
  is_read_only: boolean;
  has_side_effect: boolean;
  is_error: boolean;
  /** Added in protocol vNext; clients derive it from status for older history. */
  lifecycle?: ToolLifecycle;
  artifact_kind: ToolArtifactKind;
  activity_kind: ToolActivityKind;
  history_mode: ToolHistoryMode;
  summary_hint: string | null;
  /** Optional because older daemons do not derive structured test counts. */
  test_summary?: ToolTestSummary | null;
  /** Optional because older daemons leave provider output inspection to clients. */
  provider_output_summary?: ToolProviderOutputSummary | null;
};

export type ToolCommandAction = {
  action_kind: string;
  command: string;
  name: string | null;
  path: string | null;
  query: string | null;
};

export type ToolMcpAppContext = {
  connector_id: string;
  app_name: string | null;
  action_name: string | null;
  link_id: string | null;
  resource_uri: string | null;
  template_id: string | null;
};

export type ToolOutputContentItem =
  { kind: "text"; text: string } | { kind: "image"; url: string };

export type ToolCollabAgentState = {
  status: string;
  message: string | null;
};

export type ToolHookOutputEntry = {
  entry_kind: string;
  text: string;
};

export type ToolCallDetail =
  | {
      kind: "command_execution";
      command: string;
      cwd: string;
      actions: ToolCommandAction[];
      process_id: string | null;
      duration_ms: number | null;
      source: string | null;
    }
  | {
      kind: "mcp";
      server: string;
      tool: string;
      arguments: unknown;
      result: unknown | null;
      error: string | null;
      duration_ms: number | null;
      app_context: ToolMcpAppContext | null;
    }
  | {
      kind: "dynamic";
      tool: string;
      namespace: string | null;
      arguments: unknown;
      content_items: ToolOutputContentItem[];
      success: boolean | null;
      duration_ms: number | null;
    }
  | {
      kind: "collab_agent";
      tool: string;
      sender_thread_id: string;
      receiver_thread_ids: string[];
      prompt: string | null;
      model: string | null;
      reasoning_effort: string | null;
      agent_states: Record<string, ToolCollabAgentState>;
    }
  | {
      kind: "subagent_activity";
      activity: string;
      agent_thread_id: string;
      agent_path: string;
    }
  | {
      kind: "hook";
      event_name: string;
      handler_type: string;
      execution_mode: string;
      scope: string;
      source_path: string;
      duration_ms: number | null;
      status_message: string | null;
      entries: ToolHookOutputEntry[];
    }
  | {
      kind: "guardian_review";
      review_id: string;
      action_kind: string;
      action: string;
      cwd: string | null;
      target_item_id: string | null;
      status: string;
      risk_level: string | null;
      user_authorization: string | null;
      rationale: string | null;
      decision_source: string | null;
      duration_ms: number | null;
    };

export type WorkspaceSummary = {
  id: string;
  path: string;
  status: WorkspaceStatus;
  agents: WorkspaceAgentSummary[];
  skills?: SkillSummary[];
  default_provider?: AgentProvider;
  models: ModelSummary[];
  collaboration_modes: CollaborationModeSummary[];
  account: AccountSummary;
  current_thread_id: string | null;
  connected_at: string;
  updated_at: string;
  last_error: string | null;
};

export type ThreadPlanStep = {
  /** Provider-stable identity. Older daemons omit this field. */
  id?: string | null;
  step: string;
  status: string;
};

export type ThreadPlan = {
  explanation: string | null;
  steps: ThreadPlanStep[];
};

export type ThreadAttention = {
  level: ThreadAttentionLevel;
  badge_label: string | null;
  unread: boolean;
  pending_approval_count: number;
  pending_question_count: number;
  last_agent_activity_seq: number;
  last_read_seq: number;
};

/** A turn accepted while the thread was busy, dispatching when the active
 * turn ends. Rendered as a removable chip near the composer. */
export type QueuedTurnSummary = {
  id: string;
  preview: string;
  /** Full message text; editing starts from this, not the truncated preview.
      Optional because older daemons don't send it. */
  text?: string;
  attachment_count?: number;
  queued_at: string;
};

export type ThreadSummary = {
  id: string;
  workspace_id: string;
  title: string;
  provider: AgentProvider;
  native_session_id?: string | null;
  /** Runtime pinned when the thread was created (currently `native` or `acp`). */
  provider_transport?: string | null;
  /** Source thread when this thread is a cross-provider continuation. */
  handoff_from?: ThreadHandoffSource | null;
  origin?:
    | { kind: "scheduled_task"; task_id: string; title: string }
    | { kind: "automation"; automation_id: string; name: string }
    | null;
  status: ThreadStatus;
  updated_at: string;
  last_message_preview: string | null;
  latest_turn_id: string | null;
  latest_plan: ThreadPlan | null;
  latest_diff: string | null;
  last_tool: string | null;
  last_error: string | null;
  agent: ThreadAgentParams;
  attention: ThreadAttention;
  is_archived: boolean;
  is_pinned: boolean;
  goal: ThreadGoal | null;
  queued_turns: QueuedTurnSummary[];
  variant: ThreadVariant | null;
};

export type ThreadHandoffSource = {
  thread_id: string;
  provider: AgentProvider;
};

/** Where a new thread's turns run. Fixed when the thread is created. */
export type ThreadIsolation = "project_folder" | "isolated";

/** The isolated checkout backing a thread, when it has one. */
export type ThreadVariant = {
  slug: string;
  path: string;
  branch: string;
  kind: "clone" | "worktree";
  base_branch?: string | null;
};

export type InteractiveRequestKind = "approval" | "question" | "plan_approval";

export type ApprovalDecision = "allow" | "deny" | "always_allow";

export type PlanApprovalOutcome = "approved" | "cancelled" | "abandoned";

export type InteractiveQuestionOption = {
  label: string;
  description: string;
};

export type InteractiveQuestion = {
  id: string;
  header: string;
  question: string;
  is_other: boolean;
  is_secret: boolean;
  options: InteractiveQuestionOption[] | null;
};

export type InteractiveRequest = {
  request_id: string;
  workspace_id: string;
  thread_id: string | null;
  method: string;
  kind: InteractiveRequestKind;
  /** Exact choices offered by the provider. Missing means legacy allow/deny. */
  approval_decisions?: ApprovalDecision[];
  title: string;
  detail: string | null;
  command: string | null;
  path: string | null;
  turn_id: string | null;
  item_id: string | null;
  questions: InteractiveQuestion[];
  created_at: string;
};

export type ApprovalRequest = InteractiveRequest;

export type InteractiveResponsePayload =
  | {
      kind: "approval";
      decision: ApprovalDecision;
    }
  | {
      kind: "question";
      answers: Record<string, string[]>;
    }
  | {
      kind: "plan_approval";
      outcome: PlanApprovalOutcome;
      feedback?: string | null;
    };

export type InteractiveRequestOutcome =
  | "allowed"
  | "always_allowed"
  | "denied"
  | "answered"
  | "plan_approved"
  | "plan_changes_requested"
  | "plan_abandoned"
  | "expired"
  | "cancelled";

export type InteractiveRequestResolution = {
  outcome: InteractiveRequestOutcome;
  resolved_at: string;
};

export type ImageInput = {
  type: "image";
  id: string;
  name: string | null;
  mime_type: string | null;
  url: string;
  local_path?: string | null;
};

export type ConversationImage = {
  id: string;
  name?: string | null;
  mime_type?: string | null;
  url: string;
  local_path?: string | null;
  alt_text?: string | null;
};

export type ConversationArtifact = {
  title: string;
  /** Open-ended provider discriminator such as preview, document, or app. */
  artifact_kind: string;
  url: string | null;
  mime_type: string | null;
  version: string | null;
  content: string | null;
  /** Size-bounded provider evidence retained for inspection. */
  payload: unknown;
};

export type WebSearchActionKind =
  "search" | "open_page" | "find_in_page" | "other" | (string & {});

export type ConversationWebSearch = {
  id: string;
  query: string;
  action_kind: WebSearchActionKind;
  queries: string[];
  url: string | null;
  pattern: string | null;
};

export type ConversationFileChange = {
  path: string;
  /** Open-ended provider value; known Codex values are add/delete/update. */
  change_kind: string;
  diff: string;
  move_path: string | null;
};

export type AssistantMessagePhase = "commentary" | "final_answer";

export type MemoryCitationEntry = {
  path: string;
  line_start: number;
  line_end: number;
  note: string;
};

export type ConversationMemoryCitation = {
  entries: MemoryCitationEntry[];
  thread_ids: string[];
};

export type ConversationCitationLocator =
  | { kind: "web_search"; encrypted_index: string }
  | {
      kind: "search_result";
      search_result_index: number;
      start_block_index: number;
      end_block_index: number;
    }
  | {
      kind: "char";
      document_index: number;
      start_char_index: number;
      end_char_index: number;
      file_id?: string | null;
    }
  | {
      kind: "page";
      document_index: number;
      start_page_number: number;
      end_page_number: number;
      file_id?: string | null;
    }
  | {
      kind: "content_block";
      document_index: number;
      start_block_index: number;
      end_block_index: number;
      file_id?: string | null;
    };

/** Evidence explicitly attached to assistant content by the provider. */
export type ConversationCitation = {
  /** Stable source-part identity; absent in older daemon history. */
  id?: string | null;
  /** Open-ended provider discriminator. */
  kind: string;
  url?: string | null;
  source?: string | null;
  title?: string | null;
  cited_text?: string | null;
  /** Exact provider location; absent in older daemon history. */
  locator?: ConversationCitationLocator | null;
};

export type TextInput = {
  type: "text";
  id?: string | null;
  text: string;
};

export type TurnInputItem = TextInput | ImageInput;

export type SelectedSkillReference = {
  skill_id: string;
  alias: string;
};

export type ConversationItem =
  | {
      kind: "user_message";
      id: string;
      text: string;
      attachments: ImageInput[];
      /** Provider turn containing this message, when known. */
      turn_id?: string | null;
      /** Last completed turn before this message; safe edit/fork boundary. */
      previous_turn_id?: string | null;
      created_at: string;
      /**
       * Client-only: rendered optimistically at send time, not yet echoed by
       * the daemon. Cleared implicitly when the daemon's copy replaces it.
       */
      pending?: boolean;
    }
  | {
      kind: "assistant_message";
      id: string;
      text: string;
      /** Provider-supplied role within the turn; absent means unknown/legacy. */
      phase?: AssistantMessagePhase | null;
      /** Provider-supplied file-backed evidence for the response. */
      memory_citation?: ConversationMemoryCitation | null;
      /** Provider-emitted web, document, or retrieval citations. */
      citations?: ConversationCitation[];
      /** Omitted by older daemons and hydrated as complete by clients. */
      lifecycle?: ContentLifecycle;
      /** Provider-reported explanation when the response failed. */
      error?: string | null;
      created_at: string;
    }
  | {
      kind: "reasoning";
      id: string;
      summary: string | null;
      content: string;
      /** Omitted by older daemons and hydrated as complete by clients. */
      lifecycle?: ContentLifecycle;
      /** Authoritative elapsed time when the provider or daemon can derive it. */
      duration_ms?: number | null;
      created_at: string;
    }
  | {
      kind: "code_review";
      id: string;
      /** Review target supplied when the provider enters review mode. */
      subject: string | null;
      /** Full provider-authored review findings. */
      content: string;
      /** Omitted by older daemons and hydrated as complete by clients. */
      lifecycle?: ContentLifecycle;
      created_at: string;
    }
  | {
      kind: "context_compaction";
      id: string;
      /** Optional only for compatibility with early daemon snapshots. */
      lifecycle?: ToolLifecycle;
      created_at: string;
      completed_at: string | null;
    }
  | {
      kind: "artifact";
      id: string;
      artifact: ConversationArtifact;
      /** Omitted by older daemons and hydrated as complete by clients. */
      lifecycle?: ContentLifecycle;
      created_at: string;
    }
  | {
      kind: "unsupported";
      id: string;
      /** Provider-native discriminator retained for forward-compatible display. */
      output_kind: string | null;
      reason: string;
      /** Size-bounded provider payload retained for inspection. */
      payload: unknown;
      /** Omitted by older daemons and hydrated as complete by clients. */
      lifecycle?: ContentLifecycle;
      created_at: string;
    }
  | {
      kind: "image";
      id: string;
      title?: string | null;
      image: ConversationImage;
      /** Omitted by older daemons and hydrated as complete by clients. */
      lifecycle?: ContentLifecycle;
      created_at: string;
    }
  | {
      kind: "web_search";
      id: string;
      search: ConversationWebSearch;
      /** Omitted by older daemons and hydrated as complete by clients. */
      lifecycle?: ContentLifecycle;
      created_at: string;
    }
  | {
      kind: "file_change";
      id: string;
      changes: ConversationFileChange[];
      status: string;
      /** Omitted by older daemons and derived from status by clients. */
      lifecycle?: ToolLifecycle;
      created_at: string;
      completed_at: string | null;
    }
  | {
      kind: "tool_call";
      id: string;
      title: string;
      tool_kind: string;
      status: string;
      output: string | null;
      exit_code: number | null;
      display: ToolCallDisplay;
      detail?: ToolCallDetail | null;
      created_at: string;
      completed_at: string | null;
    }
  | {
      kind: "plan";
      id: string;
      plan: ThreadPlan;
      created_at: string;
    }
  | {
      kind: "diff";
      id: string;
      diff: string;
      created_at: string;
    }
  | {
      kind: "service";
      id: string;
      level: ServiceLevel;
      message: string;
      created_at: string;
    }
  | {
      kind: "realtime";
      id: string;
      item_type: string;
      title: string;
      summary: string | null;
      payload: unknown;
      created_at: string;
    }
  | {
      kind: "interactive_request";
      id: string;
      request: InteractiveRequest;
      created_at: string;
      resolved: boolean;
      resolution?: InteractiveRequestResolution | null;
    };

export type ThreadDetail = {
  workspace: WorkspaceSummary;
  thread: ThreadSummary;
  items: ConversationItem[];
  has_older: boolean;
  oldest_item_id: string | null;
  newest_item_id: string | null;
  is_partial: boolean;
};

export type DaemonSnapshot = {
  daemon: {
    version: string;
    started_at: string;
    capabilities?: {
      scheduled_tasks?: boolean;
    };
  };
  workspaces: WorkspaceSummary[];
  threads: ThreadSummary[];
  interactive_requests: InteractiveRequest[];
  /** Older daemons omit workspace notices; normalization always supplies an array. */
  service_notices?: ServiceNotice[];
  /** Active keyed workspace degradation; newer daemons update and clear these in place. */
  operational_conditions?: OperationalCondition[];
  /** High-frequency usage lives outside thread summaries to avoid sidebar churn. */
  thread_token_usage?: Record<string, ThreadTokenUsage>;
  preferences: FalconDeckPreferences;
  /** Installed extensions and bounded non-secret projections. */
  extensions: ExtensionSnapshot;
  /** Bounded summaries for automation owned by this daemon. */
  scheduled_tasks?: ScheduledTaskSummary[];
};

export type ScheduledTaskStatus = "active" | "paused" | "completed";
export type ScheduledTaskRunStatus =
  | "queued"
  | "running"
  | "awaiting_input"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "skipped";
export type ScheduledTaskRunTrigger = "scheduled" | "late" | "manual";

export type ScheduledTaskSchedule =
  | { kind: "once"; run_at: string; timezone: string }
  | { kind: "recurring"; rrule: string; timezone: string };

export type ScheduledTaskRunSummary = {
  id: string;
  task_id: string;
  status: ScheduledTaskRunStatus;
  trigger: ScheduledTaskRunTrigger;
  scheduled_for: string;
  started_at?: string | null;
  completed_at?: string | null;
  workspace_id: string;
  thread_id?: string | null;
  preview?: string | null;
};

export type ScheduledTaskSummary = {
  id: string;
  title: string;
  prompt_preview: string;
  status: ScheduledTaskStatus;
  schedule: ScheduledTaskSchedule;
  workspace_id: string;
  provider: AgentProvider;
  next_run_at?: string | null;
  last_run?: ScheduledTaskRunSummary | null;
  updated_at: string;
};

export type ScheduledTaskDetail = ScheduledTaskSummary & {
  prompt: string;
  model_id?: string | null;
  reasoning_effort?: string | null;
  collaboration_mode_id?: string | null;
  approval_policy?: string | null;
  permission_mode?: string | null;
  sandbox_mode?: string | null;
  isolation: ThreadIsolation;
  selected_skills: SelectedSkillReference[];
  created_at: string;
};

export type CreateScheduledTaskPayload = {
  title: string;
  prompt: string;
  workspace_id: string;
  provider: AgentProvider;
  schedule: ScheduledTaskSchedule;
  model_id?: string | null;
  reasoning_effort?: string | null;
  collaboration_mode_id?: string | null;
  approval_policy?: string | null;
  permission_mode?: string | null;
  sandbox_mode?: string | null;
  isolation?: ThreadIsolation;
  selected_skills?: SelectedSkillReference[];
};

export type UpdateScheduledTaskPayload = Partial<CreateScheduledTaskPayload> & {
  status?: ScheduledTaskStatus;
};

export type ExtensionStatus = "disabled" | "active" | "error";

export type ExtensionActionContribution = {
  id: string;
  title: string;
};

export type ExtensionViewContribution = {
  id: string;
  title?: string | null;
  view: string;
  /** Static declarative fallback used before a host publishes this view. */
  ui?: ExtensionUiDocument | null;
  /** Client-only diagnostic retained when a newer or malformed UI document is normalized. */
  uiUnsupportedReason?: string | null;
};

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

export type ExtensionUiActionBinding = {
  actionId: string;
  input?: unknown;
  target?: ExtensionViewScope | null;
};

export type ExtensionUiSelectOption = {
  value: string;
  label: string;
  tone?: ExtensionUiTone | null;
};

export type ExtensionUiFilterBinding = {
  view: string;
  path: string[];
  operator: "includes_any";
};

export type ExtensionUiNode =
  | { type: "stack"; gap?: ExtensionUiGap | null; children: ExtensionUiNode[] }
  | {
      type: "row";
      gap?: ExtensionUiGap | null;
      wrap?: boolean;
      children: ExtensionUiNode[];
    }
  | {
      type: "text";
      text: string;
      style?: ExtensionUiTextStyle | null;
      tone?: ExtensionUiTone | null;
    }
  | { type: "badge"; text: string; tone?: ExtensionUiTone | null }
  | { type: "divider" }
  | {
      type: "button";
      label: string;
      action: ExtensionUiActionBinding;
      variant?: ExtensionUiButtonVariant | null;
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
      description?: string | null;
    };

export type ExtensionUiDocument = {
  version: 1;
  root: ExtensionUiNode;
};

export type UnsupportedExtensionContribution = {
  kind: string;
  entries: unknown[];
};

export type ExtensionContributions = {
  threadMenuActions: ExtensionActionContribution[];
  threadDecorations: ExtensionViewContribution[];
  sidebarFilters: ExtensionViewContribution[];
  /** Named full-main-area surfaces. Optional while normalizing older snapshots. */
  panels?: ExtensionViewContribution[];
  /** Contribution kinds introduced by a newer daemon. */
  unsupported?: UnsupportedExtensionContribution[];
};

export type ExtensionSummary = {
  id: string;
  name: string;
  version: string;
  source: string;
  bundled: boolean;
  enabled: boolean;
  status: ExtensionStatus;
  last_error?: string | null;
  contributes: ExtensionContributions;
  permissions: string[];
  /** User-approved subset of manifest-requested permissions. */
  granted_permissions?: string[];
};

/** Summary-only extension projection; message previews and transcripts are absent. */
export type ExtensionThreadSummary = {
  id: string;
  workspaceId: string;
  title: string;
  status: ThreadStatus;
  updatedAt: string;
  pendingApprovalCount: number;
  pendingQuestionCount: number;
};

export type ExtensionViewScope = {
  kind: string;
  id: string;
};

export type ExtensionView = {
  extension_id: string;
  view_id: string;
  scope?: ExtensionViewScope | null;
  value: unknown;
  updated_at: string;
};

export type ExtensionSnapshot = {
  catalog: ExtensionSummary[];
  views: ExtensionView[];
};

export type InvokeExtensionActionPayload = {
  target?: ExtensionViewScope | null;
  input?: unknown;
};

export type ExtensionActionResponse = {
  result: unknown;
  updated_views: ExtensionView[];
};

export type ServiceNotice = {
  id: string;
  workspace_id: string;
  level: ServiceLevel;
  message: string;
  raw_method: string | null;
  created_at: string;
};

export type OperationalCondition = {
  id: string;
  key: string;
  workspace_id: string;
  level: ServiceLevel;
  message: string;
  source: string | null;
  created_at: string;
  updated_at: string;
};

export type TokenUsageBreakdown = {
  total_tokens: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};

export type ThreadTokenUsage = {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown | null;
  model_context_window: number | null;
  updated_at: string | null;
};

export type SnapshotRequest = {
  include_archived_threads?: boolean | null;
};

export type ThreadDetailMode = "full" | "tail" | "before";

export type ThreadDetailRequest = {
  workspace_id: string;
  thread_id: string;
  mode?: ThreadDetailMode | null;
  limit?: number | null;
  before_item_id?: string | null;
};

export type EventEnvelope = {
  seq: number;
  emitted_at: string;
  workspace_id: string | null;
  thread_id: string | null;
  event:
    | { type: "snapshot"; snapshot: DaemonSnapshot }
    | { type: "start"; title?: string | null }
    | { type: "stop"; reason?: string | null }
    | { type: "turn-start"; turn_id: string }
    | {
        type: "turn-end";
        turn_id: string;
        status: string;
        error?: string | null;
      }
    | {
        type: "text";
        item_id: string;
        delta: string;
        target?:
          | "assistant_text"
          | "reasoning_summary"
          | "reasoning_content"
          | "tool_output"
          | "plan_explanation";
        /** UTF-16 offsets let clients reject gaps and repeated relay events safely. */
        start_offset?: number | null;
        end_offset?: number | null;
      }
    | {
        type: "service";
        level: ServiceLevel;
        message: string;
        raw_method?: string | null;
        notice?: ServiceNotice | null;
      }
    | {
        type: "operational-condition-upserted";
        condition: OperationalCondition;
      }
    | {
        type: "operational-condition-cleared";
        key: string;
        condition_id: string;
      }
    | { type: "thread-token-usage-updated"; usage: ThreadTokenUsage }
    | { type: "realtime-audio-started"; session_id?: string | null }
    | { type: "realtime-audio-delta"; audio: RealtimeAudioChunk }
    | {
        type: "realtime-audio-ended";
        reason?: string | null;
        interrupted: boolean;
      }
    | { type: "realtime-item-added"; item: RealtimeConversationItem }
    | { type: "tool-call-start"; item_id: string; title: string; kind: string }
    | {
        type: "tool-call-end";
        item_id: string;
        title: string;
        kind: string;
        status: string;
        exit_code?: number | null;
      }
    | {
        type: "file";
        item_id?: string | null;
        path?: string | null;
        summary: string;
      }
    | { type: "interactive-request"; request: InteractiveRequest }
    | { type: "thread-started"; thread: ThreadSummary }
    | { type: "thread-updated"; thread: ThreadSummary }
    | { type: "workspace-updated"; workspace: WorkspaceSummary }
    | { type: "preferences-updated"; preferences: FalconDeckPreferences }
    | { type: "extension-catalog-updated"; catalog: ExtensionSummary[] }
    | { type: "scheduled-task-created"; task: ScheduledTaskSummary }
    | { type: "scheduled-task-updated"; task: ScheduledTaskSummary }
    | { type: "scheduled-task-deleted"; task_id: string }
    | {
        type: "scheduled-task-run-started";
        task_id: string;
        run: ScheduledTaskRunSummary;
      }
    | {
        type: "scheduled-task-run-updated";
        task_id: string;
        run: ScheduledTaskRunSummary;
      }
    | {
        type: "extension-view-updated";
        extension_id: string;
        view_id: string;
        scope?: ExtensionViewScope | null;
        view?: ExtensionView | null;
      }
    | { type: "conversation-item-added"; item: ConversationItem }
    | { type: "conversation-item-updated"; item: ConversationItem }
    | {
        type: "control-state-changed";
        change: import("./control").ControlStateChanged;
      };
};

export type RealtimeAudioChunk = {
  item_id: string | null;
  /** Base64-encoded interleaved signed 16-bit little-endian PCM. */
  data: string;
  sample_rate: number;
  num_channels: number;
  samples_per_channel: number | null;
};

export type RealtimeConversationItem = {
  id: string;
  item_type: string;
  title: string;
  summary: string | null;
  payload: unknown;
  created_at: string;
};

export type ThreadHandle = {
  workspace: WorkspaceSummary;
  thread: ThreadSummary;
};

export type UpdateThreadPayload = {
  workspace_id: string;
  thread_id: string;
  title?: string | null;
  provider?: AgentProvider | null;
  model_id?: string | null;
  reasoning_effort?: string | null;
  collaboration_mode_id?: string | null;
  /** Tier id for future turns; `"default"` is the provider's standard tier. */
  service_tier?: string | null;
  pinned?: boolean;
  /** Clear the retained app-shutdown interruption after user acknowledgement. */
  acknowledge_interruption?: boolean;
  permission_mode?: string | null;
  approval_policy?: string | null;
  sandbox_mode?: string | null;
};

export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string };

export type StartReviewPayload = {
  workspace_id: string;
  thread_id: string;
  target: ReviewTarget;
};

export type SetThreadGoalPayload = {
  workspace_id: string;
  thread_id: string;
  objective?: string | null;
  token_budget?: number | null;
  status?: string | null;
};

export type MarkThreadReadPayload = {
  workspace_id: string;
  thread_id: string;
  read_seq: number;
};

/** No `read_seq`: the daemon walks the thread back to unread on its own. */
export type MarkThreadUnreadPayload = {
  workspace_id: string;
  thread_id: string;
};

export type GitFileStatus =
  "added" | "modified" | "deleted" | "renamed" | "untracked" | "copied";

export type GitStatusEntry = {
  path: string;
  status: GitFileStatus;
  insertions: number | null;
  deletions: number | null;
};

export type GitStatusResponse = {
  branch: string | null;
  entries: GitStatusEntry[];
};

export type GitDiffResponse = {
  diff: string;
  content: string | null;
};

export type ShipThreadMode = "pr" | "draft_pr" | "merge";

export type GitCommitPayload = {
  workspace_id: string;
  thread_id: string;
  message?: string | null;
};

export type GitCommitResponse = {
  committed: boolean;
  message?: string | null;
};

export type ShipThreadPayload = {
  workspace_id: string;
  thread_id: string;
  mode: ShipThreadMode;
};

export type ShipThreadResponse = {
  mode: ShipThreadMode;
  branch: string;
  base: string;
  committed: boolean;
  /** False when the merge landed locally but the push to origin failed. */
  pushed: boolean;
  url?: string | null;
};

export type WorkspaceFilesResponse = {
  files: string[];
  truncated: boolean;
};

export type WorkspaceFileResponse = {
  path: string;
  content: string | null;
  is_binary: boolean;
  truncated: boolean;
  version: string | null;
};

export type WriteWorkspaceFilePayload = {
  content: string;
  expected_version: string | null;
};

export type GitBranchesResponse = {
  current: string | null;
  branches: string[];
};

export type RemoteConnectionStatus =
  | "inactive"
  | "pairing_pending"
  | "device_trusted"
  | "connecting"
  | "connected"
  | "degraded"
  | "offline"
  | "revoked"
  | "error";

export type TrustedDeviceStatus = "active" | "revoked";

export type TrustedDevice = {
  device_id: string;
  session_id: string;
  label: string | null;
  status: TrustedDeviceStatus;
  /** Live relay connection right now; `status` only tracks trust. Optional
   * because older daemons/relays omit it. */
  connected?: boolean;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
};

export type MachinePresence = {
  session_id: string;
  daemon_connected: boolean;
  /** True once the connected daemon owns snapshot.current. Optional for
   * compatibility with older relays. */
  daemon_rpc_ready?: boolean;
  last_seen_at: string | null;
};

export type RelayRpcFailureCode =
  | "method_unavailable"
  | "request_conflict"
  | "responder_disconnected"
  | "timed_out";

export type SyncCursor = {
  session_id: string;
  next_seq: number;
  last_acknowledged_seq: number;
  requires_bootstrap: boolean;
  history_truncated?: boolean;
};

export type RemotePairingSession = {
  pairing_id: string;
  pairing_code: string;
  session_id: string | null;
  expires_at: string;
};

export type RelayWebSocketTicketResponse = {
  ticket: string;
  expires_at: string;
};

export type RemoteStatusResponse = {
  status: RemoteConnectionStatus;
  relay_url: string | null;
  pairing: RemotePairingSession | null;
  trusted_devices: TrustedDevice[];
  presence: MachinePresence | null;
  last_error: string | null;
};

export type PairingChallengeRequest = {
  pairing_code: string;
};

export type PairingChallengeResponse = {
  pairing_id: string;
  challenge: string;
};

export type ClaimPairingRequest = {
  pairing_code: string;
  label?: string | null;
  client_bundle?: PairingPublicKeyBundle | null;
  challenge_signature: string;
};

export type ClaimPairingResponse = {
  pairing_id: string;
  session_id: string;
  device_id: string;
  client_token: string;
  trusted_device: TrustedDevice;
  daemon_bundle?: PairingPublicKeyBundle | null;
};

export type EncryptionVariant = "data_key_v1";
export type IdentityVariant = "ed25519_v1";

export type PairingPublicKeyBundle = {
  encryption_variant: EncryptionVariant;
  identity_variant: IdentityVariant;
  public_key: string;
  identity_public_key: string;
  signature: string;
};

export type WrappedDataKey = {
  encryption_variant: EncryptionVariant;
  wrapped_key: string;
};

export type SessionKeyMaterial = {
  encryption_variant: EncryptionVariant;
  identity_variant: IdentityVariant;
  pairing_id: string;
  session_id: string;
  daemon_public_key: string;
  daemon_identity_public_key: string;
  client_public_key: string;
  client_identity_public_key: string;
  client_wrapped_data_key: WrappedDataKey;
  daemon_wrapped_data_key: WrappedDataKey | null;
  signature: string;
};

export type EncryptedEnvelope = {
  encryption_variant: EncryptionVariant;
  ciphertext: string;
};

export type RelayUpdateBody =
  | { t: "session-bootstrap"; material: SessionKeyMaterial }
  | { t: "encrypted"; envelope: EncryptedEnvelope }
  | { t: "action-status"; action: QueuedRemoteAction }
  | { t: "presence"; presence: MachinePresence };

export type RelayUpdate = {
  id: string;
  seq: number;
  body: RelayUpdateBody;
  created_at: string;
};

export type RelayUpdatesResponse = {
  session_id: string;
  updates: RelayUpdate[];
  next_seq: number;
  cursor: SyncCursor;
  presence: MachinePresence;
};

export type QueuedRemoteActionStatus =
  "queued" | "dispatched" | "executing" | "completed" | "failed";

export type QueuedRemoteAction = {
  action_id: string;
  session_id: string;
  device_id: string;
  action_type: string;
  idempotency_key: string;
  status: QueuedRemoteActionStatus;
  created_at: string;
  updated_at: string;
  error: string | null;
  result: EncryptedEnvelope | null;
};

export type SubmitQueuedActionRequest = {
  idempotency_key: string;
  action_type: string;
  payload: EncryptedEnvelope;
};

export type RelayServerMessage =
  | {
      type: "ready";
      session_id: string;
      role: "daemon" | "client";
      next_seq: number;
    }
  | { type: "pong" }
  | {
      type: "sync";
      updates: RelayUpdate[];
      next_seq: number;
      history_truncated?: boolean;
      /**
       * Authoritative daemon presence at the relay's sync cursor. Optional
       * while rolling out to relays that predate this field.
       */
      presence?: MachinePresence;
    }
  | { type: "update"; update: RelayUpdate }
  | {
      type: "action-requested";
      action: QueuedRemoteAction;
      payload: EncryptedEnvelope;
    }
  | { type: "action-updated"; action: QueuedRemoteAction }
  | { type: "presence"; presence: MachinePresence }
  | { type: "ephemeral"; body: unknown }
  | {
      type: "rpc-request";
      request_id: string;
      method: string;
      params: EncryptedEnvelope;
    }
  | {
      type: "rpc-result";
      request_id: string;
      ok: boolean;
      result?: EncryptedEnvelope | null;
      error?: EncryptedEnvelope | null;
      failure?: RelayRpcFailureCode | null;
    }
  | { type: "error"; message: string };

export type RelayClientMessage =
  | { type: "ping" }
  | { type: "sync"; after_seq?: number | null }
  | { type: "update"; body: RelayUpdateBody }
  | { type: "ephemeral"; body: unknown }
  | { type: "rpc-register"; method: string }
  | { type: "rpc-unregister"; method: string }
  | {
      type: "rpc-call";
      request_id: string;
      method: string;
      params: EncryptedEnvelope;
    }
  | {
      type: "rpc-result";
      request_id: string;
      ok: boolean;
      result?: EncryptedEnvelope | null;
      error?: EncryptedEnvelope | null;
    }
  | {
      type: "action-update";
      action_id: string;
      status: QueuedRemoteActionStatus;
      error?: string | null;
      result?: EncryptedEnvelope | null;
    }
  // Sent by the daemon when an agent needs attention; the relay forwards it as
  // a push notification to disconnected devices. Clients never send it — it is
  // mirrored here for protocol parity with the Rust types.
  | {
      type: "notify";
      kind: string;
      workspace_id?: string | null;
      thread_id?: string | null;
    };

export type SpeechCredentialStatus = {
  configured: boolean;
  storage: "daemon_secret_store";
};
