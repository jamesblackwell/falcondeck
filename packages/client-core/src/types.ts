export type WorkspaceStatus =
  | 'connecting'
  | 'ready'
  | 'needs_auth'
  | 'busy'
  | 'disconnected'
  | 'error'

export type AgentProvider = 'codex' | 'claude'
export type ThreadStatus = 'idle' | 'running' | 'waiting_for_input' | 'error'
export type ServiceLevel = 'info' | 'warning' | 'error'
export type ThreadAttentionLevel = 'none' | 'unread' | 'running' | 'awaiting_response' | 'error'

export type ReasoningEffortOption = {
  reasoning_effort: string
  description: string
}

export type ModelSummary = {
  id: string
  label: string
  is_default: boolean
  default_reasoning_effort: string | null
  supported_reasoning_efforts: ReasoningEffortOption[]
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
  supports_review?: boolean
}

export type WorkspaceAgentSummary = {
  provider: AgentProvider
  account: AccountSummary
  models: ModelSummary[]
  collaboration_modes: CollaborationModeSummary[]
  supports_plan_mode?: boolean
  supports_native_plan_mode?: boolean
  capabilities?: AgentCapabilitySummary
}

export type ThreadAgentParams = {
  model_id: string | null
  reasoning_effort: string | null
  collaboration_mode_id: string | null
  approval_policy: string | null
  service_tier: string | null
}

export type ToolDetailsMode = 'auto' | 'expanded' | 'compact' | 'hide_read_only_details'

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
}

export type UpdatePreferencesPayload = {
  conversation?: UpdateConversationPreferences | null
}

export type ToolArtifactKind = 'none' | 'diff' | 'test' | 'command_output' | 'approval_related'

export type ToolCallDisplay = {
  is_read_only: boolean
  has_side_effect: boolean
  is_error: boolean
  artifact_kind: ToolArtifactKind
  summary_hint: string | null
}

export type WorkspaceSummary = {
  id: string
  path: string
  status: WorkspaceStatus
  agents: WorkspaceAgentSummary[]
  default_provider?: AgentProvider
  models: ModelSummary[]
  collaboration_modes: CollaborationModeSummary[]
  supports_plan_mode?: boolean
  supports_native_plan_mode?: boolean
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

export type ImageInput = {
  type: 'image'
  id: string
  name: string | null
  mime_type: string | null
  url: string
  local_path?: string | null
}

export type TextInput = {
  type: 'text'
  id?: string | null
  text: string
}

export type TurnInputItem = TextInput | ImageInput

export type ConversationItem =
  | {
      kind: 'user_message'
      id: string
      text: string
      attachments: ImageInput[]
      created_at: string
    }
  | {
      kind: 'assistant_message'
      id: string
      text: string
      created_at: string
    }
  | {
      kind: 'reasoning'
      id: string
      summary: string | null
      content: string
      created_at: string
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
      kind: 'interactive_request'
      id: string
      request: InteractiveRequest
      created_at: string
      resolved: boolean
    }

export type ThreadDetail = {
  workspace: WorkspaceSummary
  thread: ThreadSummary
  items: ConversationItem[]
}

export type DaemonSnapshot = {
  daemon: {
    version: string
    started_at: string
  }
  workspaces: WorkspaceSummary[]
  threads: ThreadSummary[]
  interactive_requests: InteractiveRequest[]
  preferences: FalconDeckPreferences
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
    | { type: 'text'; item_id: string; delta: string }
    | { type: 'service'; level: ServiceLevel; message: string; raw_method?: string | null }
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
    | { type: 'preferences-updated'; preferences: FalconDeckPreferences }
    | { type: 'conversation-item-added'; item: ConversationItem }
    | { type: 'conversation-item-updated'; item: ConversationItem }
}

export type ThreadHandle = {
  workspace: WorkspaceSummary
  thread: ThreadSummary
}

export type UpdateThreadPayload = {
  workspace_id: string
  thread_id: string
  provider?: AgentProvider | null
  model_id?: string | null
  reasoning_effort?: string | null
  collaboration_mode_id?: string | null
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
