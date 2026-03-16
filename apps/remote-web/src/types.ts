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

export type ThreadSummary = {
  id: string
  workspace_id: string
  title: string
  status: string
  updated_at: string
  last_message_preview: string | null
}

export type WorkspaceSummary = {
  id: string
  path: string
  status: string
  account: { label: string }
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
    | { type: 'text'; item_id: string; delta: string }
    | { type: 'service'; message: string; level: string }
    | { type: 'approval-request'; request: ApprovalRequest }
    | { type: 'turn-start'; turn_id: string }
    | { type: 'turn-end'; turn_id: string; status: string; error?: string | null }
}

export type RelayUpdate = {
  id: string
  seq: number
  body: unknown
  created_at: string
}

export type ClaimPairingResponse = {
  session_id: string
  client_token: string
}

export type RelayServerMessage =
  | { type: 'ready'; session_id: string; role: string; next_seq: number }
  | { type: 'sync'; updates: RelayUpdate[]; next_seq: number }
  | { type: 'update'; update: RelayUpdate }
  | { type: 'rpc-result'; request_id: string; ok: boolean; result?: unknown; error?: string | null }
  | { type: 'error'; message: string }

export type RelayClientMessage =
  | { type: 'sync'; after_seq?: number }
  | { type: 'rpc-call'; request_id: string; method: string; params: unknown }
