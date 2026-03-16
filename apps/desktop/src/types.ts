export type WorkspaceStatus =
  | 'connecting'
  | 'ready'
  | 'needs_auth'
  | 'busy'
  | 'disconnected'
  | 'error'

export type ThreadStatus = 'idle' | 'running' | 'waiting_for_approval' | 'error'
export type ServiceLevel = 'info' | 'warning' | 'error'

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
