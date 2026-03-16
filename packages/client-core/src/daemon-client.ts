import type {
  CollaborationModeSummary,
  DaemonSnapshot,
  EventEnvelope,
  RemoteStatusResponse,
  ThreadDetail,
  ThreadHandle,
  TurnInputItem,
  WorkspaceSummary,
} from './types'

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(payload?.error ?? `Request failed with status ${response.status}`)
  }
  return response.json() as Promise<T>
}

export type SendTurnPayload = {
  workspace_id: string
  thread_id: string
  inputs: TurnInputItem[]
  model_id?: string | null
  reasoning_effort?: string | null
  collaboration_mode_id?: string | null
  approval_policy?: string | null
  service_tier?: string | null
}

export type StartThreadPayload = {
  workspace_id: string
  model_id?: string | null
  collaboration_mode_id?: string | null
  approval_policy?: string | null
}

export function createDaemonApiClient(baseUrl: string) {
  return {
    async snapshot() {
      return parseJson<DaemonSnapshot>(await fetch(`${baseUrl}/api/snapshot`))
    },
    async remoteStatus() {
      return parseJson<RemoteStatusResponse>(await fetch(`${baseUrl}/api/remote/status`))
    },
    async startRemotePairing(relay_url: string) {
      return parseJson<RemoteStatusResponse>(
        await fetch(`${baseUrl}/api/remote/pairing`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ relay_url }),
        }),
      )
    },
    async connectWorkspace(path: string) {
      return parseJson<WorkspaceSummary>(
        await fetch(`${baseUrl}/api/workspaces/connect`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path }),
        }),
      )
    },
    async startThread(payload: StartThreadPayload) {
      return parseJson<ThreadHandle>(
        await fetch(`${baseUrl}/api/workspaces/${payload.workspace_id}/threads`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      )
    },
    async threadDetail(workspaceId: string, threadId: string) {
      return parseJson<ThreadDetail>(
        await fetch(`${baseUrl}/api/workspaces/${workspaceId}/threads/${threadId}`),
      )
    },
    async collaborationModes(workspaceId: string) {
      return parseJson<CollaborationModeSummary[]>(
        await fetch(`${baseUrl}/api/workspaces/${workspaceId}/collaboration-modes`),
      )
    },
    async sendTurn(payload: SendTurnPayload) {
      return parseJson<{ ok: boolean; message?: string | null }>(
        await fetch(`${baseUrl}/api/workspaces/${payload.workspace_id}/threads/${payload.thread_id}/turns`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      )
    },
    async respondApproval(
      workspaceId: string,
      requestId: string,
      decision: 'allow' | 'deny' | 'always_allow',
    ) {
      return parseJson<{ ok: boolean; message?: string | null }>(
        await fetch(`${baseUrl}/api/workspaces/${workspaceId}/approvals/${requestId}/respond`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision }),
        }),
      )
    },
    connectEvents(onEvent: (event: EventEnvelope) => void) {
      const socket = new WebSocket(baseUrl.replace('http', 'ws') + '/api/events')
      socket.onmessage = (message) => {
        onEvent(JSON.parse(message.data) as EventEnvelope)
      }
      return socket
    },
  }
}
