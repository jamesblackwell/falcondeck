export type WorkspaceStatus =
  | 'connecting'
  | 'ready'
  | 'needs_auth'
  | 'busy'
  | 'disconnected'
  | 'error'

export type ThreadStatus = 'idle' | 'running' | 'waiting_for_approval' | 'error'
export type ServiceLevel = 'info' | 'warning' | 'error'

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
  model_id: string | null
  reasoning_effort: string | null
}

export type AccountSummary = {
  status: 'unknown' | 'ready' | 'needs_auth'
  label: string
}

export type ThreadCodexParams = {
  model_id: string | null
  reasoning_effort: string | null
  collaboration_mode_id: string | null
  approval_policy: string | null
  service_tier: string | null
}

export type WorkspaceSummary = {
  id: string
  path: string
  status: WorkspaceStatus
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

export type ThreadSummary = {
  id: string
  workspace_id: string
  title: string
  status: ThreadStatus
  updated_at: string
  last_message_preview: string | null
  latest_turn_id: string | null
  latest_plan: ThreadPlan | null
  latest_diff: string | null
  last_tool: string | null
  last_error: string | null
  codex: ThreadCodexParams
}

export type ApprovalRequest = {
  request_id: string
  workspace_id: string
  thread_id: string | null
  method: string
  title: string
  detail: string | null
  command: string | null
  path: string | null
  created_at: string
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
      kind: 'approval'
      id: string
      request: ApprovalRequest
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
  approvals: ApprovalRequest[]
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
    | { type: 'approval-request'; request: ApprovalRequest }
    | { type: 'thread-started'; thread: ThreadSummary }
    | { type: 'thread-updated'; thread: ThreadSummary }
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
  model_id?: string | null
  reasoning_effort?: string | null
  collaboration_mode_id?: string | null
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
  | 'waiting_for_claim'
  | 'connecting'
  | 'connected'
  | 'error'

export type RemotePairingSession = {
  pairing_id: string
  pairing_code: string
  session_id: string | null
  expires_at: string
}

export type RemoteStatusResponse = {
  status: RemoteConnectionStatus
  relay_url: string | null
  pairing: RemotePairingSession | null
  last_error: string | null
}

export type EncryptionVariant = 'data_key_v1'

export type PairingPublicKeyBundle = {
  encryption_variant: EncryptionVariant
  public_key: string
}

export type WrappedDataKey = {
  encryption_variant: EncryptionVariant
  wrapped_key: string
}

export type SessionKeyMaterial = {
  encryption_variant: EncryptionVariant
  daemon_public_key: string
  client_public_key: string
  client_wrapped_data_key: WrappedDataKey
  daemon_wrapped_data_key: WrappedDataKey | null
}

export type EncryptedEnvelope = {
  encryption_variant: EncryptionVariant
  ciphertext: string
}

export type RelayUpdateBody =
  | { t: 'session-bootstrap'; material: SessionKeyMaterial }
  | { t: 'encrypted'; envelope: EncryptedEnvelope }

export type RelayUpdate = {
  id: string
  seq: number
  body: RelayUpdateBody
  created_at: string
}

export type RelayServerMessage =
  | { type: 'ready'; session_id: string; role: 'daemon' | 'client'; next_seq: number }
  | { type: 'pong' }
  | { type: 'sync'; updates: RelayUpdate[]; next_seq: number }
  | { type: 'update'; update: RelayUpdate }
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
  | { type: 'sync'; after_seq?: number | null }
  | { type: 'update'; body: RelayUpdateBody }
  | { type: 'rpc-register'; method: string }
  | { type: 'rpc-call'; request_id: string; method: string; params: EncryptedEnvelope }
  | {
      type: 'rpc-result'
      request_id: string
      ok: boolean
      result?: EncryptedEnvelope | null
      error?: EncryptedEnvelope | null
    }
