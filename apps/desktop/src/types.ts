export type WorkspaceStatus =
  | 'connecting'
  | 'ready'
  | 'needs_auth'
  | 'busy'
  | 'disconnected'
  | 'error'

export type ThreadStatus = 'idle' | 'running' | 'waiting_for_input' | 'error'
export type ServiceLevel = 'info' | 'warning' | 'error'
export type ThreadAttentionLevel = 'none' | 'unread' | 'running' | 'awaiting_response' | 'error'

export type ModelSummary = {
  id: string
  label: string
  is_default: boolean
}

export type AccountSummary = {
  status: 'unknown' | 'ready' | 'needs_auth'
  label: string
}

export type WorkspaceSummary = {
  id: string
  path: string
  status: WorkspaceStatus
  models: ModelSummary[]
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
  status: ThreadStatus
  updated_at: string
  last_message_preview: string | null
  latest_turn_id: string | null
  latest_plan: ThreadPlan | null
  latest_diff: string | null
  last_tool: string | null
  last_error: string | null
  attention: ThreadAttention
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

export type DaemonSnapshot = {
  daemon: {
    version: string
    started_at: string
  }
  workspaces: WorkspaceSummary[]
  threads: ThreadSummary[]
  interactive_requests: InteractiveRequest[]
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
}

export type ThreadHandle = {
  workspace: WorkspaceSummary
  thread: ThreadSummary
}

export type TimelineEntry = {
  id: string
  at: string
  kind: 'text' | 'service' | 'tool'
  label: string
  text?: string
  markdown?: string
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
