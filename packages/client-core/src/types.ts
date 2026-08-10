export type WorkspaceStatus =
  | 'connecting'
  | 'ready'
  | 'needs_auth'
  | 'busy'
  | 'disconnected'
  | 'error'

/**
 * Provider id as sent by the daemon. Open-ended on purpose: the daemon can
 * register providers we have never heard of (ACP-configured CLIs), so this is a
 * plain string and unknown ids must survive round-tripping.
 */
export type AgentProvider = string

/** Providers with first-class support in the clients (icons, copy, defaults). */
export const KNOWN_PROVIDERS = ['codex', 'claude'] as const
export type KnownProvider = (typeof KNOWN_PROVIDERS)[number]
export type ThreadStatus = 'idle' | 'running' | 'waiting_for_input' | 'error'
export type ServiceLevel = 'info' | 'warning' | 'error'
export type ThreadAttentionLevel = 'none' | 'unread' | 'running' | 'awaiting_response' | 'error'

export type ReasoningEffortOption = {
  reasoning_effort: string
  description: string
}

/**
 * A service tier a model can run on beyond the provider's standard tier
 * (Codex fast mode advertises `{id: "priority", name: "Fast"}`). `id` is what
 * turn requests carry back; `name`/`description` are display copy.
 */
export type ServiceTierOption = {
  id: string
  name: string
  description: string
}

export type ModelSummary = {
  id: string
  label: string
  is_default: boolean
  default_reasoning_effort: string | null
  supported_reasoning_efforts: ReasoningEffortOption[]
  /** Extra service tiers; absent/empty hides the speed toggle. Optional because older daemons omit it. */
  service_tiers?: ServiceTierOption[]
  default_service_tier?: string | null
}

export type CollaborationModeSummary = {
  id: string
  label: string
  mode?: string | null
  model_id: string | null
  reasoning_effort: string | null
  is_native?: boolean
}

export type AccountSummary = {
  status: 'unknown' | 'ready' | 'needs_auth'
  label: string
}

export type AgentCapabilitySummary = {
  supports_review: boolean
  supports_goals: boolean
  supports_images: boolean
  supports_skills: boolean
  supports_interrupt: boolean
  /** Whether a message can be injected into a running turn to redirect it. */
  supports_steering: boolean
  /** Whether the provider can branch history at a completed turn boundary. */
  supports_forking: boolean
  /** Sandbox modes the provider accepts; empty hides the sandbox picker. */
  sandbox_modes: string[]
  /** Permission modes the provider accepts; empty hides the picker. */
  permission_modes: string[]
}

export type SkillAvailability = 'codex' | 'claude' | 'both'
export type SkillSourceKind = 'provider_native' | 'project_file' | 'home_file'

export type CodexSkillTranslation = {
  native_id?: string | null
  native_name?: string | null
}

export type ClaudeSkillTranslation = {
  command_name?: string | null
  prompt_reference_path?: string | null
}

export type SkillProviderTranslations = {
  codex?: CodexSkillTranslation | null
  claude?: ClaudeSkillTranslation | null
}

export type SkillSummary = {
  id: string
  label: string
  alias: string
  /** Legacy two-provider projection; prefer `providers`. */
  availability: SkillAvailability
  /** Open list of provider ids that can use this skill. */
  providers: AgentProvider[]
  source_kind: SkillSourceKind
  source_path?: string | null
  description?: string | null
  provider_translations?: SkillProviderTranslations | null
}

export type WorkspaceAgentSummary = {
  provider: AgentProvider
  /** Human-readable provider name for pickers. */
  label: string
  account: AccountSummary
  models: ModelSummary[]
  collaboration_modes: CollaborationModeSummary[]
  skills?: SkillSummary[]
  capabilities?: AgentCapabilitySummary
}

export type ThreadAgentParams = {
  model_id: string | null
  reasoning_effort: string | null
  collaboration_mode_id: string | null
  approval_policy: string | null
  service_tier: string | null
  permission_mode?: string | null
  sandbox_mode?: string | null
}

export type ThreadGoal = {
  objective: string
  status: string
  token_budget?: number | null
  tokens_used?: number | null
  time_used_seconds?: number | null
}

export type ToolDetailsMode = 'collapsed' | 'auto' | 'expanded' | 'compact' | 'hide_read_only_details'

/**
 * How reasoning/thinking blocks reveal themselves, copied from Zed's four-value
 * setting. `auto` follows the stream — expanded while the thought arrives, then
 * collapsed once it ends unless the reader has toggled it. `preview` keeps a
 * height-capped excerpt visible that a click promotes to the full text.
 */
export type ThinkingDisplay = 'auto' | 'preview' | 'always_expanded' | 'always_collapsed'

export type ConversationAutoExpandPreferences = {
  approvals: boolean
  errors: boolean
  first_diff: boolean
  failed_tests: boolean
}

export type ConversationPreferences = {
  tool_details_mode: ToolDetailsMode
  auto_expand: ConversationAutoExpandPreferences
  group_read_only_tools: boolean
  show_expand_all_controls: boolean
  thinking_display: ThinkingDisplay
}

export type FalconDeckPreferences = {
  version: number
  conversation: ConversationPreferences
}

export type UpdateConversationAutoExpandPreferences = Partial<ConversationAutoExpandPreferences>

export type UpdateConversationPreferences = {
  tool_details_mode?: ToolDetailsMode | null
  auto_expand?: UpdateConversationAutoExpandPreferences | null
  group_read_only_tools?: boolean | null
  show_expand_all_controls?: boolean | null
  thinking_display?: ThinkingDisplay | null
}

export type UpdatePreferencesPayload = {
  conversation?: UpdateConversationPreferences | null
}

export type ToolArtifactKind = 'none' | 'diff' | 'test' | 'command_output' | 'approval_related'
export type ToolActivityKind =
  | 'read'
  | 'search'
  | 'list'
  | 'command'
  | 'edit'
  | 'test'
  | 'approval'
  | 'diff'
  | 'web_search'
  | 'image_view'
  | 'context'
  | 'other'
export type ToolHistoryMode = 'summary' | 'full'
export type ToolLifecycle =
  | 'unknown'
  | 'queued'
  | 'awaiting_approval'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'interrupted'
export type ContentLifecycle = 'pending' | 'streaming' | 'complete' | 'interrupted' | 'error'

export type ToolTestSummary = {
  framework: string | null
  total: number | null
  passed: number | null
  failed: number | null
  skipped: number | null
  suites_total: number | null
  suites_passed: number | null
  suites_failed: number | null
  duration_ms: number | null
}

export type ToolCallDisplay = {
  is_read_only: boolean
  has_side_effect: boolean
  is_error: boolean
  /** Added in protocol vNext; clients derive it from status for older history. */
  lifecycle?: ToolLifecycle
  artifact_kind: ToolArtifactKind
  activity_kind: ToolActivityKind
  history_mode: ToolHistoryMode
  summary_hint: string | null
  /** Optional because older daemons do not derive structured test counts. */
  test_summary?: ToolTestSummary | null
}

export type ToolCommandAction = {
  action_kind: string
  command: string
  name: string | null
  path: string | null
  query: string | null
}

export type ToolMcpAppContext = {
  connector_id: string
  app_name: string | null
  action_name: string | null
  link_id: string | null
  resource_uri: string | null
  template_id: string | null
}

export type ToolOutputContentItem =
  | { kind: 'text'; text: string }
  | { kind: 'image'; url: string }

export type ToolCollabAgentState = {
  status: string
  message: string | null
}

export type ToolHookOutputEntry = {
  entry_kind: string
  text: string
}

export type ToolCallDetail =
  | {
      kind: 'command_execution'
      command: string
      cwd: string
      actions: ToolCommandAction[]
      process_id: string | null
      duration_ms: number | null
      source: string | null
    }
  | {
      kind: 'mcp'
      server: string
      tool: string
      arguments: unknown
      result: unknown | null
      error: string | null
      duration_ms: number | null
      app_context: ToolMcpAppContext | null
    }
  | {
      kind: 'dynamic'
      tool: string
      namespace: string | null
      arguments: unknown
      content_items: ToolOutputContentItem[]
      success: boolean | null
      duration_ms: number | null
    }
  | {
      kind: 'collab_agent'
      tool: string
      sender_thread_id: string
      receiver_thread_ids: string[]
      prompt: string | null
      model: string | null
      reasoning_effort: string | null
      agent_states: Record<string, ToolCollabAgentState>
    }
  | {
      kind: 'subagent_activity'
      activity: string
      agent_thread_id: string
      agent_path: string
    }
  | {
      kind: 'hook'
      event_name: string
      handler_type: string
      execution_mode: string
      scope: string
      source_path: string
      duration_ms: number | null
      status_message: string | null
      entries: ToolHookOutputEntry[]
    }
  | {
      kind: 'guardian_review'
      review_id: string
      action_kind: string
      action: string
      cwd: string | null
      target_item_id: string | null
      status: string
      risk_level: string | null
      user_authorization: string | null
      rationale: string | null
      decision_source: string | null
      duration_ms: number | null
    }

export type WorkspaceSummary = {
  id: string
  path: string
  status: WorkspaceStatus
  agents: WorkspaceAgentSummary[]
  skills?: SkillSummary[]
  default_provider?: AgentProvider
  models: ModelSummary[]
  collaboration_modes: CollaborationModeSummary[]
  account: AccountSummary
  current_thread_id: string | null
  connected_at: string
  updated_at: string
  last_error: string | null
}

export type ThreadPlanStep = {
  step: string
  status: string
}

export type ThreadPlan = {
  explanation: string | null
  steps: ThreadPlanStep[]
}

export type ThreadAttention = {
  level: ThreadAttentionLevel
  badge_label: string | null
  unread: boolean
  pending_approval_count: number
  pending_question_count: number
  last_agent_activity_seq: number
  last_read_seq: number
}

/** A turn accepted while the thread was busy, dispatching when the active
 * turn ends. Rendered as a removable chip near the composer. */
export type QueuedTurnSummary = {
  id: string
  preview: string
  /** Full message text; editing starts from this, not the truncated preview.
      Optional because older daemons don't send it. */
  text?: string
  attachment_count?: number
  queued_at: string
}

export type ThreadSummary = {
  id: string
  workspace_id: string
  title: string
  provider: AgentProvider
  native_session_id?: string | null
  status: ThreadStatus
  updated_at: string
  last_message_preview: string | null
  latest_turn_id: string | null
  latest_plan: ThreadPlan | null
  latest_diff: string | null
  last_tool: string | null
  last_error: string | null
  agent: ThreadAgentParams
  attention: ThreadAttention
  is_archived: boolean
  is_pinned: boolean
  goal: ThreadGoal | null
  queued_turns: QueuedTurnSummary[]
  variant: ThreadVariant | null
}

/** Where a new thread's turns run. Fixed when the thread is created. */
export type ThreadIsolation = 'project_folder' | 'isolated'

/** The isolated checkout backing a thread, when it has one. */
export type ThreadVariant = {
  slug: string
  path: string
  branch: string
  kind: 'clone' | 'worktree'
}

export type InteractiveRequestKind = 'approval' | 'question'

export type InteractiveQuestionOption = {
  label: string
  description: string
}

export type InteractiveQuestion = {
  id: string
  header: string
  question: string
  is_other: boolean
  is_secret: boolean
  options: InteractiveQuestionOption[] | null
}

export type InteractiveRequest = {
  request_id: string
  workspace_id: string
  thread_id: string | null
  method: string
  kind: InteractiveRequestKind
  title: string
  detail: string | null
  command: string | null
  path: string | null
  turn_id: string | null
  item_id: string | null
  questions: InteractiveQuestion[]
  created_at: string
}

export type ApprovalRequest = InteractiveRequest

export type InteractiveResponsePayload =
  | {
      kind: 'approval'
      decision: 'allow' | 'deny' | 'always_allow'
    }
  | {
      kind: 'question'
      answers: Record<string, string[]>
    }

export type InteractiveRequestOutcome =
  | 'allowed'
  | 'always_allowed'
  | 'denied'
  | 'answered'
  | 'expired'
  | 'cancelled'

export type InteractiveRequestResolution = {
  outcome: InteractiveRequestOutcome
  resolved_at: string
}

export type ImageInput = {
  type: 'image'
  id: string
  name: string | null
  mime_type: string | null
  url: string
  local_path?: string | null
}

export type ConversationImage = {
  id: string
  name?: string | null
  mime_type?: string | null
  url: string
  local_path?: string | null
  alt_text?: string | null
}

export type WebSearchActionKind = 'search' | 'open_page' | 'find_in_page' | 'other'

export type ConversationWebSearch = {
  id: string
  query: string
  action_kind: WebSearchActionKind
  queries: string[]
  url: string | null
  pattern: string | null
}

export type ConversationFileChange = {
  path: string
  /** Open-ended provider value; known Codex values are add/delete/update. */
  change_kind: string
  diff: string
  move_path: string | null
}

export type AssistantMessagePhase = 'commentary' | 'final_answer'

export type MemoryCitationEntry = {
  path: string
  line_start: number
  line_end: number
  note: string
}

export type ConversationMemoryCitation = {
  entries: MemoryCitationEntry[]
  thread_ids: string[]
}

/** Evidence explicitly attached to assistant content by the provider. */
export type ConversationCitation = {
  /** Open-ended provider discriminator. */
  kind: string
  url?: string | null
  source?: string | null
  title?: string | null
  cited_text?: string | null
}

export type TextInput = {
  type: 'text'
  id?: string | null
  text: string
}

export type TurnInputItem = TextInput | ImageInput

export type SelectedSkillReference = {
  skill_id: string
  alias: string
}

export type ConversationItem =
  | {
      kind: 'user_message'
      id: string
      text: string
      attachments: ImageInput[]
      /** Provider turn containing this message, when known. */
      turn_id?: string | null
      /** Last completed turn before this message; safe edit/fork boundary. */
      previous_turn_id?: string | null
      created_at: string
    }
  | {
      kind: 'assistant_message'
      id: string
      text: string
      /** Provider-supplied role within the turn; absent means unknown/legacy. */
      phase?: AssistantMessagePhase | null
      /** Provider-supplied file-backed evidence for the response. */
      memory_citation?: ConversationMemoryCitation | null
      /** Provider-emitted web, document, or retrieval citations. */
      citations?: ConversationCitation[]
      /** Omitted by older daemons and hydrated as complete by clients. */
      lifecycle?: ContentLifecycle
      created_at: string
    }
  | {
      kind: 'reasoning'
      id: string
      summary: string | null
      content: string
      /** Omitted by older daemons and hydrated as complete by clients. */
      lifecycle?: ContentLifecycle
      created_at: string
    }
  | {
      kind: 'image'
      id: string
      title?: string | null
      image: ConversationImage
      /** Omitted by older daemons and hydrated as complete by clients. */
      lifecycle?: ContentLifecycle
      created_at: string
    }
  | {
      kind: 'web_search'
      id: string
      search: ConversationWebSearch
      /** Omitted by older daemons and hydrated as complete by clients. */
      lifecycle?: ContentLifecycle
      created_at: string
    }
  | {
      kind: 'file_change'
      id: string
      changes: ConversationFileChange[]
      status: string
      /** Omitted by older daemons and derived from status by clients. */
      lifecycle?: ToolLifecycle
      created_at: string
      completed_at: string | null
    }
  | {
      kind: 'tool_call'
      id: string
      title: string
      tool_kind: string
      status: string
      output: string | null
      exit_code: number | null
      display: ToolCallDisplay
      detail?: ToolCallDetail | null
      created_at: string
      completed_at: string | null
    }
  | {
      kind: 'plan'
      id: string
      plan: ThreadPlan
      created_at: string
    }
  | {
      kind: 'diff'
      id: string
      diff: string
      created_at: string
    }
  | {
      kind: 'service'
      id: string
      level: ServiceLevel
      message: string
      created_at: string
    }
  | {
      kind: 'realtime'
      id: string
      item_type: string
      title: string
      summary: string | null
      payload: unknown
      created_at: string
    }
  | {
      kind: 'interactive_request'
      id: string
      request: InteractiveRequest
      created_at: string
      resolved: boolean
      resolution?: InteractiveRequestResolution | null
    }

export type ThreadDetail = {
  workspace: WorkspaceSummary
  thread: ThreadSummary
  items: ConversationItem[]
  has_older: boolean
  oldest_item_id: string | null
  newest_item_id: string | null
  is_partial: boolean
}

export type DaemonSnapshot = {
  daemon: {
    version: string
    started_at: string
  }
  workspaces: WorkspaceSummary[]
  threads: ThreadSummary[]
  interactive_requests: InteractiveRequest[]
  /** Older daemons omit workspace notices; normalization always supplies an array. */
  service_notices?: ServiceNotice[]
  /** High-frequency usage lives outside thread summaries to avoid sidebar churn. */
  thread_token_usage?: Record<string, ThreadTokenUsage>
  preferences: FalconDeckPreferences
}

export type ServiceNotice = {
  id: string
  workspace_id: string
  level: ServiceLevel
  message: string
  raw_method: string | null
  created_at: string
}

export type TokenUsageBreakdown = {
  total_tokens: number
  input_tokens: number
  cached_input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number
}

export type ThreadTokenUsage = {
  total: TokenUsageBreakdown
  last: TokenUsageBreakdown | null
  model_context_window: number | null
  updated_at: string | null
}

export type SnapshotRequest = {
  include_archived_threads?: boolean | null
}

export type ThreadDetailMode = 'full' | 'tail' | 'before'

export type ThreadDetailRequest = {
  workspace_id: string
  thread_id: string
  mode?: ThreadDetailMode | null
  limit?: number | null
  before_item_id?: string | null
}

export type EventEnvelope = {
  seq: number
  emitted_at: string
  workspace_id: string | null
  thread_id: string | null
  event:
    | { type: 'snapshot'; snapshot: DaemonSnapshot }
    | { type: 'start'; title?: string | null }
    | { type: 'stop'; reason?: string | null }
    | { type: 'turn-start'; turn_id: string }
    | { type: 'turn-end'; turn_id: string; status: string; error?: string | null }
    | {
        type: 'text'
        item_id: string
        delta: string
        target?: 'assistant_text' | 'reasoning_summary' | 'reasoning_content' | 'tool_output' | 'plan_explanation'
        /** UTF-16 offsets let clients reject gaps and repeated relay events safely. */
        start_offset?: number | null
        end_offset?: number | null
      }
    | { type: 'service'; level: ServiceLevel; message: string; raw_method?: string | null; notice?: ServiceNotice | null }
    | { type: 'thread-token-usage-updated'; usage: ThreadTokenUsage }
    | { type: 'realtime-audio-started'; session_id?: string | null }
    | { type: 'realtime-audio-delta'; audio: RealtimeAudioChunk }
    | { type: 'realtime-audio-ended'; reason?: string | null; interrupted: boolean }
    | { type: 'realtime-item-added'; item: RealtimeConversationItem }
    | { type: 'tool-call-start'; item_id: string; title: string; kind: string }
    | {
        type: 'tool-call-end'
        item_id: string
        title: string
        kind: string
        status: string
        exit_code?: number | null
      }
    | { type: 'file'; item_id?: string | null; path?: string | null; summary: string }
    | { type: 'interactive-request'; request: InteractiveRequest }
    | { type: 'thread-started'; thread: ThreadSummary }
    | { type: 'thread-updated'; thread: ThreadSummary }
    | { type: 'workspace-updated'; workspace: WorkspaceSummary }
    | { type: 'preferences-updated'; preferences: FalconDeckPreferences }
    | { type: 'conversation-item-added'; item: ConversationItem }
    | { type: 'conversation-item-updated'; item: ConversationItem }
}

export type RealtimeAudioChunk = {
  item_id: string | null
  /** Base64-encoded interleaved signed 16-bit little-endian PCM. */
  data: string
  sample_rate: number
  num_channels: number
  samples_per_channel: number | null
}

export type RealtimeConversationItem = {
  id: string
  item_type: string
  title: string
  summary: string | null
  payload: unknown
  created_at: string
}

export type ThreadHandle = {
  workspace: WorkspaceSummary
  thread: ThreadSummary
}

export type UpdateThreadPayload = {
  workspace_id: string
  thread_id: string
  title?: string | null
  provider?: AgentProvider | null
  model_id?: string | null
  reasoning_effort?: string | null
  /** Tier id for future turns; `"default"` is the provider's standard tier. */
  service_tier?: string | null
  pinned?: boolean
  permission_mode?: string | null
  sandbox_mode?: string | null
}

export type ReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string }

export type StartReviewPayload = {
  workspace_id: string
  thread_id: string
  target: ReviewTarget
}

export type SetThreadGoalPayload = {
  workspace_id: string
  thread_id: string
  objective?: string | null
  token_budget?: number | null
  status?: string | null
}

export type MarkThreadReadPayload = {
  workspace_id: string
  thread_id: string
  read_seq: number
}

export type GitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'copied'

export type GitStatusEntry = {
  path: string
  status: GitFileStatus
  insertions: number | null
  deletions: number | null
}

export type GitStatusResponse = {
  branch: string | null
  entries: GitStatusEntry[]
}

export type GitDiffResponse = {
  diff: string
  content: string | null
}

export type WorkspaceFilesResponse = {
  files: string[]
  truncated: boolean
}

export type WorkspaceFileResponse = {
  path: string
  content: string | null
  is_binary: boolean
  truncated: boolean
  version: string | null
}

export type WriteWorkspaceFilePayload = {
  content: string
  expected_version: string | null
}

export type GitBranchesResponse = {
  current: string | null
  branches: string[]
}

export type RemoteConnectionStatus =
  | 'inactive'
  | 'pairing_pending'
  | 'device_trusted'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'offline'
  | 'revoked'
  | 'error'

export type TrustedDeviceStatus = 'active' | 'revoked'

export type TrustedDevice = {
  device_id: string
  session_id: string
  label: string | null
  status: TrustedDeviceStatus
  /** Live relay connection right now; `status` only tracks trust. Optional
   * because older daemons/relays omit it. */
  connected?: boolean
  created_at: string
  last_seen_at: string | null
  revoked_at: string | null
}

export type MachinePresence = {
  session_id: string
  daemon_connected: boolean
  last_seen_at: string | null
}

export type SyncCursor = {
  session_id: string
  next_seq: number
  last_acknowledged_seq: number
  requires_bootstrap: boolean
  history_truncated?: boolean
}

export type RemotePairingSession = {
  pairing_id: string
  pairing_code: string
  session_id: string | null
  expires_at: string
}

export type RelayWebSocketTicketResponse = {
  ticket: string
  expires_at: string
}

export type RemoteStatusResponse = {
  status: RemoteConnectionStatus
  relay_url: string | null
  pairing: RemotePairingSession | null
  trusted_devices: TrustedDevice[]
  presence: MachinePresence | null
  last_error: string | null
}

export type PairingChallengeRequest = {
  pairing_code: string
}

export type PairingChallengeResponse = {
  pairing_id: string
  challenge: string
}

export type ClaimPairingRequest = {
  pairing_code: string
  label?: string | null
  client_bundle?: PairingPublicKeyBundle | null
  challenge_signature: string
}

export type ClaimPairingResponse = {
  pairing_id: string
  session_id: string
  device_id: string
  client_token: string
  trusted_device: TrustedDevice
  daemon_bundle?: PairingPublicKeyBundle | null
}

export type EncryptionVariant = 'data_key_v1'
export type IdentityVariant = 'ed25519_v1'

export type PairingPublicKeyBundle = {
  encryption_variant: EncryptionVariant
  identity_variant: IdentityVariant
  public_key: string
  identity_public_key: string
  signature: string
}

export type WrappedDataKey = {
  encryption_variant: EncryptionVariant
  wrapped_key: string
}

export type SessionKeyMaterial = {
  encryption_variant: EncryptionVariant
  identity_variant: IdentityVariant
  pairing_id: string
  session_id: string
  daemon_public_key: string
  daemon_identity_public_key: string
  client_public_key: string
  client_identity_public_key: string
  client_wrapped_data_key: WrappedDataKey
  daemon_wrapped_data_key: WrappedDataKey | null
  signature: string
}

export type EncryptedEnvelope = {
  encryption_variant: EncryptionVariant
  ciphertext: string
}

export type RelayUpdateBody =
  | { t: 'session-bootstrap'; material: SessionKeyMaterial }
  | { t: 'encrypted'; envelope: EncryptedEnvelope }
  | { t: 'action-status'; action: QueuedRemoteAction }
  | { t: 'presence'; presence: MachinePresence }

export type RelayUpdate = {
  id: string
  seq: number
  body: RelayUpdateBody
  created_at: string
}

export type RelayUpdatesResponse = {
  session_id: string
  updates: RelayUpdate[]
  next_seq: number
  cursor: SyncCursor
  presence: MachinePresence
}

export type QueuedRemoteActionStatus =
  | 'queued'
  | 'dispatched'
  | 'executing'
  | 'completed'
  | 'failed'

export type QueuedRemoteAction = {
  action_id: string
  session_id: string
  device_id: string
  action_type: string
  idempotency_key: string
  status: QueuedRemoteActionStatus
  created_at: string
  updated_at: string
  error: string | null
  result: EncryptedEnvelope | null
}

export type SubmitQueuedActionRequest = {
  idempotency_key: string
  action_type: string
  payload: EncryptedEnvelope
}

export type RelayServerMessage =
  | { type: 'ready'; session_id: string; role: 'daemon' | 'client'; next_seq: number }
  | { type: 'pong' }
  | { type: 'sync'; updates: RelayUpdate[]; next_seq: number; history_truncated?: boolean }
  | { type: 'update'; update: RelayUpdate }
  | { type: 'action-requested'; action: QueuedRemoteAction; payload: EncryptedEnvelope }
  | { type: 'action-updated'; action: QueuedRemoteAction }
  | { type: 'presence'; presence: MachinePresence }
  | { type: 'ephemeral'; body: unknown }
  | { type: 'rpc-request'; request_id: string; method: string; params: EncryptedEnvelope }
  | {
      type: 'rpc-result'
      request_id: string
      ok: boolean
      result?: EncryptedEnvelope | null
      error?: EncryptedEnvelope | null
    }
  | { type: 'error'; message: string }

export type RelayClientMessage =
  | { type: 'ping' }
  | { type: 'sync'; after_seq?: number | null }
  | { type: 'update'; body: RelayUpdateBody }
  | { type: 'ephemeral'; body: unknown }
  | { type: 'rpc-register'; method: string }
  | { type: 'rpc-unregister'; method: string }
  | { type: 'rpc-call'; request_id: string; method: string; params: EncryptedEnvelope }
  | {
      type: 'rpc-result'
      request_id: string
      ok: boolean
      result?: EncryptedEnvelope | null
      error?: EncryptedEnvelope | null
    }
  | {
      type: 'action-update'
      action_id: string
      status: QueuedRemoteActionStatus
      error?: string | null
      result?: EncryptedEnvelope | null
    }
  // Sent by the daemon when an agent needs attention; the relay forwards it as
  // a push notification to disconnected devices. Clients never send it — it is
  // mirrored here for protocol parity with the Rust types.
  | {
      type: 'notify'
      kind: string
      workspace_id?: string | null
      thread_id?: string | null
    }
