import type {
  AgentProvider,
  CollaborationModeSummary,
  DaemonSnapshot,
  EventEnvelope,
  GitDiffResponse,
  GitFileStatus,
  GitStatusResponse,
  InteractiveResponsePayload,
  MarkThreadReadPayload,
  RemoteStatusResponse,
  SnapshotRequest,
  SelectedSkillReference,
  FalconDeckPreferences,
  ThreadDetail,
  ThreadDetailRequest,
  ThreadHandle,
  ThreadIsolation,
  ThreadSummary,
  TurnInputItem,
  UpdatePreferencesPayload,
  SetThreadGoalPayload,
  StartReviewPayload,
  UpdateThreadPayload,
  WorkspaceSummary,
} from './types'
import {
  normalizeDaemonSnapshot,
  normalizeEventEnvelope,
  normalizePreferences,
  normalizeThreadDetail,
  normalizeThreadHandle,
  normalizeThreadSummary,
} from './normalization'

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
  selected_skills?: SelectedSkillReference[]
  provider?: AgentProvider | null
  model_id?: string | null
  reasoning_effort?: string | null
  approval_policy?: string | null
  service_tier?: string | null
  permission_mode?: string | null
  sandbox_mode?: string | null
}

export type StartThreadPayload = {
  workspace_id: string
  provider?: AgentProvider | null
  model_id?: string | null
  approval_policy?: string | null
  permission_mode?: string | null
  sandbox_mode?: string | null
  /** Omitted means the project folder — isolation is always opt-in. */
  isolation?: ThreadIsolation
}

export function createDaemonApiClient(baseUrl: string) {
  return {
    async snapshot(request: SnapshotRequest = {}) {
      const params = new URLSearchParams()
      if (request.include_archived_threads != null) {
        params.set('include_archived_threads', String(request.include_archived_threads))
      }
      // URLSearchParams.size is missing in some RN polyfills.
      const query = params.toString()
      const suffix = query ? `?${query}` : ''
      return normalizeDaemonSnapshot(
        await parseJson<DaemonSnapshot>(await fetch(`${baseUrl}/api/snapshot${suffix}`)),
      )
    },
    async preferences() {
      return normalizePreferences(
        await parseJson<FalconDeckPreferences>(await fetch(`${baseUrl}/api/preferences`)),
      )
    },
    async updatePreferences(payload: UpdatePreferencesPayload) {
      return normalizePreferences(
        await parseJson<FalconDeckPreferences>(
          await fetch(`${baseUrl}/api/preferences`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }),
        ),
      )
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
    async revokeRemoteDevice(deviceId: string) {
      return parseJson<RemoteStatusResponse>(
        await fetch(`${baseUrl}/api/remote/devices/${encodeURIComponent(deviceId)}`, {
          method: 'DELETE',
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
    async removeWorkspace(workspaceId: string) {
      return parseJson<{ ok: boolean; message?: string | null }>(
        await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}`, {
          method: 'DELETE',
        }),
      )
    },
    async startThread(payload: StartThreadPayload) {
      return normalizeThreadHandle(
        await parseJson<ThreadHandle>(await fetch(`${baseUrl}/api/workspaces/${payload.workspace_id}/threads`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })),
      )
    },
    async threadDetail(
      workspaceId: string,
      threadId: string,
      request: Omit<ThreadDetailRequest, 'workspace_id' | 'thread_id'> = {},
    ) {
      const params = new URLSearchParams()
      if (request.mode) params.set('mode', request.mode)
      if (request.limit != null) params.set('limit', String(request.limit))
      if (request.before_item_id) params.set('before_item_id', request.before_item_id)
      // URLSearchParams.size is missing in some RN polyfills.
      const query = params.toString()
      const suffix = query ? `?${query}` : ''
      return normalizeThreadDetail(
        await parseJson<ThreadDetail>(
          await fetch(`${baseUrl}/api/workspaces/${workspaceId}/threads/${threadId}${suffix}`),
        ),
      )
    },
    async updateThread(payload: UpdateThreadPayload) {
      return normalizeThreadHandle(
        await parseJson<ThreadHandle>(await fetch(`${baseUrl}/api/workspaces/${payload.workspace_id}/threads/${payload.thread_id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })),
      )
    },
    async collaborationModes(workspaceId: string) {
      return parseJson<CollaborationModeSummary[]>(
        await fetch(`${baseUrl}/api/workspaces/${workspaceId}/collaboration-modes`),
      )
    },
    async archiveThread(workspaceId: string, threadId: string) {
      return normalizeThreadSummary(
        await parseJson<ThreadSummary>(await fetch(`${baseUrl}/api/workspaces/${workspaceId}/threads/${threadId}/archive`, {
          method: 'POST',
        })),
      )
    },
    async unarchiveThread(workspaceId: string, threadId: string) {
      return normalizeThreadSummary(
        await parseJson<ThreadSummary>(await fetch(`${baseUrl}/api/workspaces/${workspaceId}/threads/${threadId}/unarchive`, {
          method: 'POST',
        })),
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
    async interruptTurn(workspaceId: string, threadId: string) {
      return parseJson<{ ok: boolean; message?: string | null }>(
        await fetch(
          `${baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}/interrupt`,
          { method: 'POST' },
        ),
      )
    },
    async removeQueuedTurn(workspaceId: string, threadId: string, queuedId: string) {
      return parseJson<{ ok: boolean; message?: string | null }>(
        await fetch(
          `${baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(queuedId)}`,
          { method: 'DELETE' },
        ),
      )
    },
    async steerQueuedTurn(workspaceId: string, threadId: string, queuedId: string) {
      return parseJson<{ ok: boolean; message?: string | null }>(
        await fetch(
          `${baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(queuedId)}/steer`,
          { method: 'POST' },
        ),
      )
    },
    async startReview(payload: StartReviewPayload) {
      return parseJson<{ ok: boolean; message?: string | null }>(
        await fetch(`${baseUrl}/api/workspaces/${payload.workspace_id}/threads/${payload.thread_id}/review`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: payload.target }),
        }),
      )
    },
    async setThreadGoal(payload: SetThreadGoalPayload) {
      return normalizeThreadSummary(
        await parseJson<ThreadSummary>(await fetch(`${baseUrl}/api/workspaces/${payload.workspace_id}/threads/${payload.thread_id}/goal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })),
      )
    },
    async clearThreadGoal(workspaceId: string, threadId: string) {
      return normalizeThreadSummary(
        await parseJson<ThreadSummary>(await fetch(`${baseUrl}/api/workspaces/${workspaceId}/threads/${threadId}/goal`, {
          method: 'DELETE',
        })),
      )
    },
    async markThreadRead(payload: MarkThreadReadPayload) {
      return normalizeThreadSummary(
        await parseJson<ThreadSummary>(await fetch(`${baseUrl}/api/workspaces/${payload.workspace_id}/threads/${payload.thread_id}/read`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ read_seq: payload.read_seq }),
        })),
      )
    },
    async respondInteractive(
      workspaceId: string,
      requestId: string,
      response: InteractiveResponsePayload,
    ) {
      return parseJson<{ ok: boolean; message?: string | null }>(
        await fetch(`${baseUrl}/api/workspaces/${workspaceId}/interactive-requests/${requestId}/respond`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ response }),
        }),
      )
    },
    // An isolated thread's changes live in its own checkout, so status and
    // diffs are asked per thread; omitting it reports the project folder.
    async gitStatus(workspaceId: string, threadId?: string | null) {
      const query = new URLSearchParams()
      if (threadId) query.set('thread_id', threadId)
      const params = query.toString() ? `?${query.toString()}` : ''
      return parseJson<GitStatusResponse>(
        await fetch(`${baseUrl}/api/workspaces/${workspaceId}/git/status${params}`),
      )
    },
    async gitDiff(
      workspaceId: string,
      path?: string,
      status?: GitFileStatus | null,
      threadId?: string | null,
    ) {
      const query = new URLSearchParams()
      if (path) query.set('path', path)
      if (status) query.set('status', status)
      if (threadId) query.set('thread_id', threadId)
      const params = query.toString() ? `?${query.toString()}` : ''
      return parseJson<GitDiffResponse>(
        await fetch(`${baseUrl}/api/workspaces/${workspaceId}/git/diff${params}`),
      )
    },
    async deleteThread(workspaceId: string, threadId: string) {
      return parseJson<{ ok: boolean; message?: string | null }>(
        await fetch(
          `${baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}`,
          { method: 'DELETE' },
        ),
      )
    },
    connectEvents(onEvent: (event: EventEnvelope) => void) {
      const socket = new WebSocket(baseUrl.replace('http', 'ws') + '/api/events')
      socket.onmessage = (message) => {
        let event: EventEnvelope
        try {
          event = normalizeEventEnvelope(JSON.parse(message.data) as EventEnvelope)
        } catch {
          // A malformed frame must not throw inside onmessage and kill the stream.
          console.warn('Ignoring malformed daemon event frame')
          return
        }
        onEvent(event)
      }
      return socket
    },
  }
}
