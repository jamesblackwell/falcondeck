import type {
  AgentProvider,
  CollaborationModeSummary,
  CreateScheduledTaskPayload,
  DaemonSnapshot,
  EventEnvelope,
  ExtensionActionResponse,
  ExtensionSnapshot,
  ExtensionSummary,
  GitBranchesResponse,
  GitCommitResponse,
  GitDiffResponse,
  GitFileStatus,
  GitStatusResponse,
  HarnessesOverview,
  HarnessUpgradeJob,
  ShipThreadMode,
  ShipThreadResponse,
  WorkspaceFileResponse,
  WorkspaceFilesResponse,
  WriteWorkspaceFilePayload,
  InteractiveResponsePayload,
  InvokeExtensionActionPayload,
  MarkThreadReadPayload,
  MarkThreadUnreadPayload,
  RemoteStatusResponse,
  ScheduledTaskDetail,
  ScheduledTaskRunSummary,
  ScheduledTaskSummary,
  SnapshotRequest,
  ThreadMessageSearchRequest,
  ThreadMessageSearchResponse,
  SpeechCredentialStatus,
  ProviderUsageOverview,
  SelectedSkillReference,
  FalconDeckPreferences,
  ThreadDetail,
  ThreadDetailRequest,
  ThreadHandle,
  ThreadHandoffSource,
  ThreadIsolation,
  ThreadSummary,
  TurnInputItem,
  UpdatePreferencesPayload,
  UpdateScheduledTaskPayload,
  SetThreadGoalPayload,
  StartReviewPayload,
  UpdateThreadPayload,
  WorkspaceSummary,
} from "./types";
import type {
  ControlExecuteRequest,
  ControlExecuteResponse,
  ControlGetRequest,
  ControlGetResponse,
  ControlSearchRequest,
  ControlSearchResponse,
} from "./control";
import {
  normalizeDaemonSnapshot,
  normalizeEventEnvelope,
  normalizeHarnessesOverview,
  normalizeHarnessUpgradeJob,
  normalizePreferences,
  normalizeThreadDetail,
  normalizeThreadHandle,
  normalizeThreadSummary,
} from "./normalization";
import { fetchWithTimeout } from "./transport-timeout";

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    // Carry the HTTP status so callers can branch on it (e.g. a 404 from an
    // in-memory job store after a daemon restart) instead of parsing the
    // daemon's error text.
    const error = new Error(
      payload?.error ?? `Request failed with status ${response.status}`,
    ) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export type SendTurnPayload = {
  workspace_id: string;
  thread_id: string;
  inputs: TurnInputItem[];
  selected_skills?: SelectedSkillReference[];
  provider?: AgentProvider | null;
  model_id?: string | null;
  reasoning_effort?: string | null;
  approval_policy?: string | null;
  service_tier?: string | null;
  permission_mode?: string | null;
  sandbox_mode?: string | null;
  /** Apply this follow-up to the active turn instead of queueing it. */
  steer?: boolean;
  /**
   * Id the client already used to render this message optimistically. The
   * daemon echoes the user item under this id so the optimistic copy
   * reconciles in place instead of duplicating.
   */
  user_item_id?: string | null;
};

export type StartThreadPayload = {
  workspace_id: string;
  provider?: AgentProvider | null;
  model_id?: string | null;
  collaboration_mode_id?: string | null;
  approval_policy?: string | null;
  permission_mode?: string | null;
  sandbox_mode?: string | null;
  /** Omitted means the project folder — isolation is always opt-in. */
  isolation?: ThreadIsolation;
  /** Creates a linked destination while leaving the source thread unchanged. */
  handoff_from?: ThreadHandoffSource | null;
};

export type ForkThreadPayload = {
  workspace_id: string;
  thread_id: string;
  last_turn_id: string;
};

export function createDaemonApiClient(baseUrl: string) {
  return {
    async snapshot(request: SnapshotRequest = {}) {
      const params = new URLSearchParams();
      if (request.include_archived_threads != null) {
        params.set(
          "include_archived_threads",
          String(request.include_archived_threads),
        );
      }
      // URLSearchParams.size is missing in some RN polyfills.
      const query = params.toString();
      const suffix = query ? `?${query}` : "";
      return normalizeDaemonSnapshot(
        await parseJson<DaemonSnapshot>(
          await fetchWithTimeout(`${baseUrl}/api/snapshot${suffix}`),
        ),
      );
    },
    /**
     * Keyword search over the user messages the daemon indexed from provider
     * session files. Titles are searched client-side; this covers the case
     * where the thread's title never mentioned the thing you remember typing.
     */
    async searchThreadMessages(
      request: ThreadMessageSearchRequest,
      init?: { signal?: AbortSignal },
    ) {
      return parseJson<ThreadMessageSearchResponse>(
        await fetch(`${baseUrl}/api/threads/search`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: init?.signal,
        }),
      );
    },
    async preferences() {
      return normalizePreferences(
        await parseJson<FalconDeckPreferences>(
          await fetch(`${baseUrl}/api/preferences`),
        ),
      );
    },
    async updatePreferences(payload: UpdatePreferencesPayload) {
      return normalizePreferences(
        await parseJson<FalconDeckPreferences>(
          await fetch(`${baseUrl}/api/preferences`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }),
        ),
      );
    },
    async speechCredentialStatus() {
      return parseJson<SpeechCredentialStatus>(
        await fetch(`${baseUrl}/api/speech/openrouter-key`),
      );
    },
    async providerUsage() {
      return parseJson<ProviderUsageOverview>(
        await fetch(`${baseUrl}/api/provider-usage`),
      );
    },
    async saveSpeechCredential(apiKey: string) {
      return parseJson<SpeechCredentialStatus>(
        await fetch(`${baseUrl}/api/speech/openrouter-key`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ api_key: apiKey }),
        }),
      );
    },
    async deleteSpeechCredential() {
      return parseJson<SpeechCredentialStatus>(
        await fetch(`${baseUrl}/api/speech/openrouter-key`, {
          method: "DELETE",
        }),
      );
    },
    async extensions() {
      return parseJson<ExtensionSnapshot>(
        await fetch(`${baseUrl}/api/extensions`),
      );
    },
    async updateExtension(extensionId: string, enabled: boolean) {
      return parseJson<ExtensionSummary>(
        await fetch(
          `${baseUrl}/api/extensions/${encodeURIComponent(extensionId)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled }),
          },
        ),
      );
    },
    async updateExtensionPermission(
      extensionId: string,
      permission: string,
      granted: boolean,
    ) {
      return parseJson<ExtensionSummary>(
        await fetch(
          `${baseUrl}/api/extensions/${encodeURIComponent(extensionId)}/permissions`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ permission, granted }),
          },
        ),
      );
    },
    async invokeExtensionAction(
      extensionId: string,
      actionId: string,
      payload: InvokeExtensionActionPayload,
    ) {
      return parseJson<ExtensionActionResponse>(
        await fetch(
          `${baseUrl}/api/extensions/${encodeURIComponent(extensionId)}/actions/${encodeURIComponent(actionId)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          },
        ),
      );
    },
    async setClientActivity(active: boolean) {
      await parseJson<void>(
        await fetch(`${baseUrl}/api/client-activity`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ active }),
        }),
      );
    },
    async remoteStatus() {
      return parseJson<RemoteStatusResponse>(
        await fetchWithTimeout(`${baseUrl}/api/remote/status`),
      );
    },
    /** Cached (60s) local harness inventory; shallow, no network lookups. */
    async harnesses() {
      return normalizeHarnessesOverview(
        await parseJson<HarnessesOverview>(
          await fetch(`${baseUrl}/api/harnesses`),
        ),
      );
    },
    /** Deep re-probe; `includeLatest` (default true) also hits package registries. */
    async refreshHarnesses(options: { includeLatest?: boolean } = {}) {
      return normalizeHarnessesOverview(
        await parseJson<HarnessesOverview>(
          await fetch(`${baseUrl}/api/harnesses/refresh`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ include_latest: options.includeLatest ?? true }),
          }),
        ),
      );
    },
    /** Starts an install/upgrade job; poll it with `harnessUpgradeJob`. */
    async upgradeHarness(harnessId: string) {
      const body = await parseJson<{ job_id: string }>(
        await fetch(`${baseUrl}/api/harnesses/upgrade`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ harness_id: harnessId }),
        }),
      );
      return body.job_id;
    },
    async harnessUpgradeJob(jobId: string) {
      const job = normalizeHarnessUpgradeJob(
        await parseJson<HarnessUpgradeJob>(
          await fetch(
            `${baseUrl}/api/harnesses/jobs/${encodeURIComponent(jobId)}`,
          ),
        ),
      );
      if (!job) throw new Error("invalid harness upgrade job response");
      return job;
    },
    async startRemotePairing(relay_url: string) {
      return parseJson<RemoteStatusResponse>(
        await fetch(`${baseUrl}/api/remote/pairing`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ relay_url }),
        }),
      );
    },
    async revokeRemoteDevice(deviceId: string) {
      return parseJson<RemoteStatusResponse>(
        await fetch(
          `${baseUrl}/api/remote/devices/${encodeURIComponent(deviceId)}`,
          {
            method: "DELETE",
          },
        ),
      );
    },
    async scheduledTasks() {
      return parseJson<ScheduledTaskSummary[]>(
        await fetch(`${baseUrl}/api/scheduled-tasks`),
      );
    },
    async scheduledTask(taskId: string) {
      return parseJson<ScheduledTaskDetail>(
        await fetch(
          `${baseUrl}/api/scheduled-tasks/${encodeURIComponent(taskId)}`,
        ),
      );
    },
    async createScheduledTask(payload: CreateScheduledTaskPayload) {
      return parseJson<ScheduledTaskDetail>(
        await fetch(`${baseUrl}/api/scheduled-tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
    },
    async updateScheduledTask(
      taskId: string,
      payload: UpdateScheduledTaskPayload,
    ) {
      return parseJson<ScheduledTaskDetail>(
        await fetch(
          `${baseUrl}/api/scheduled-tasks/${encodeURIComponent(taskId)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          },
        ),
      );
    },
    async deleteScheduledTask(taskId: string) {
      return parseJson<{ ok: boolean; message?: string | null }>(
        await fetch(
          `${baseUrl}/api/scheduled-tasks/${encodeURIComponent(taskId)}`,
          { method: "DELETE" },
        ),
      );
    },
    async runScheduledTask(taskId: string) {
      return parseJson<ScheduledTaskRunSummary>(
        await fetch(
          `${baseUrl}/api/scheduled-tasks/${encodeURIComponent(taskId)}/run`,
          { method: "POST" },
        ),
      );
    },
    async scheduledTaskRuns(taskId: string) {
      return parseJson<ScheduledTaskRunSummary[]>(
        await fetch(
          `${baseUrl}/api/scheduled-tasks/${encodeURIComponent(taskId)}/runs`,
        ),
      );
    },
    /**
     * Agent control: capability discovery, reads and mutations. The daemon
     * owns the behaviour; these mirror the three generic control routes the
     * MCP server also calls.
     */
    async controlSearch(request: ControlSearchRequest = {}) {
      return parseJson<ControlSearchResponse>(
        await fetch(`${baseUrl}/api/control/search`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        }),
      );
    },
    async controlGet(request: ControlGetRequest) {
      return parseJson<ControlGetResponse>(
        await fetch(`${baseUrl}/api/control/get`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        }),
      );
    },
    async controlExecute(request: ControlExecuteRequest) {
      const response = parseJson<ControlExecuteResponse>(
        await fetch(`${baseUrl}/api/control/execute`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        }),
      );
      return response;
    },
    async connectWorkspace(path: string) {
      return parseJson<WorkspaceSummary>(
        await fetch(`${baseUrl}/api/workspaces/connect`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path }),
        }),
      );
    },
    async removeWorkspace(workspaceId: string) {
      return parseJson<{ ok: boolean; message?: string | null }>(
        await fetch(
          `${baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}`,
          {
            method: "DELETE",
          },
        ),
      );
    },
    async startThread(payload: StartThreadPayload) {
      return normalizeThreadHandle(
        await parseJson<ThreadHandle>(
          await fetch(
            `${baseUrl}/api/workspaces/${payload.workspace_id}/threads`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            },
          ),
        ),
      );
    },
    async forkThread(payload: ForkThreadPayload) {
      return normalizeThreadHandle(
        await parseJson<ThreadHandle>(
          await fetch(
            `${baseUrl}/api/workspaces/${encodeURIComponent(payload.workspace_id)}/threads/${encodeURIComponent(payload.thread_id)}/fork`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            },
          ),
        ),
      );
    },
    async threadDetail(
      workspaceId: string,
      threadId: string,
      request: Omit<ThreadDetailRequest, "workspace_id" | "thread_id"> = {},
    ) {
      const params = new URLSearchParams();
      if (request.mode) params.set("mode", request.mode);
      if (request.limit != null) params.set("limit", String(request.limit));
      if (request.before_item_id)
        params.set("before_item_id", request.before_item_id);
      // URLSearchParams.size is missing in some RN polyfills.
      const query = params.toString();
      const suffix = query ? `?${query}` : "";
      return normalizeThreadDetail(
        await parseJson<ThreadDetail>(
          await fetch(
            `${baseUrl}/api/workspaces/${workspaceId}/threads/${threadId}${suffix}`,
          ),
        ),
      );
    },
    async updateThread(payload: UpdateThreadPayload) {
      return normalizeThreadHandle(
        await parseJson<ThreadHandle>(
          await fetch(
            `${baseUrl}/api/workspaces/${payload.workspace_id}/threads/${payload.thread_id}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            },
          ),
        ),
      );
    },
    async collaborationModes(workspaceId: string) {
      return parseJson<CollaborationModeSummary[]>(
        await fetch(
          `${baseUrl}/api/workspaces/${workspaceId}/collaboration-modes`,
        ),
      );
    },
    async archiveThread(workspaceId: string, threadId: string) {
      return normalizeThreadSummary(
        await parseJson<ThreadSummary>(
          await fetch(
            `${baseUrl}/api/workspaces/${workspaceId}/threads/${threadId}/archive`,
            {
              method: "POST",
            },
          ),
        ),
      );
    },
    async unarchiveThread(workspaceId: string, threadId: string) {
      return normalizeThreadSummary(
        await parseJson<ThreadSummary>(
          await fetch(
            `${baseUrl}/api/workspaces/${workspaceId}/threads/${threadId}/unarchive`,
            {
              method: "POST",
            },
          ),
        ),
      );
    },
    async sendTurn(payload: SendTurnPayload) {
      return parseJson<{ ok: boolean; message?: string | null }>(
        await fetch(
          `${baseUrl}/api/workspaces/${payload.workspace_id}/threads/${payload.thread_id}/turns`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          },
        ),
      );
    },
    async interruptTurn(workspaceId: string, threadId: string) {
      return parseJson<{ ok: boolean; message?: string | null }>(
        await fetch(
          `${baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}/interrupt`,
          { method: "POST" },
        ),
      );
    },
    async removeQueuedTurn(
      workspaceId: string,
      threadId: string,
      queuedId: string,
    ) {
      return parseJson<{ ok: boolean; message?: string | null }>(
        await fetch(
          `${baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(queuedId)}`,
          { method: "DELETE" },
        ),
      );
    },
    async steerQueuedTurn(
      workspaceId: string,
      threadId: string,
      queuedId: string,
    ) {
      return parseJson<{ ok: boolean; message?: string | null }>(
        await fetch(
          `${baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(queuedId)}/steer`,
          { method: "POST" },
        ),
      );
    },
    async editQueuedTurn(
      workspaceId: string,
      threadId: string,
      queuedId: string,
      text: string,
    ) {
      return parseJson<{ ok: boolean; message?: string | null }>(
        await fetch(
          `${baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(queuedId)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
          },
        ),
      );
    },
    async reorderQueuedTurns(
      workspaceId: string,
      threadId: string,
      queuedIds: string[],
    ) {
      return parseJson<{ ok: boolean; message?: string | null }>(
        await fetch(
          `${baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}/queue/reorder`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ queued_ids: queuedIds }),
          },
        ),
      );
    },
    async startReview(payload: StartReviewPayload) {
      return parseJson<{ ok: boolean; message?: string | null }>(
        await fetch(
          `${baseUrl}/api/workspaces/${payload.workspace_id}/threads/${payload.thread_id}/review`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ target: payload.target }),
          },
        ),
      );
    },
    async setThreadGoal(payload: SetThreadGoalPayload) {
      return normalizeThreadSummary(
        await parseJson<ThreadSummary>(
          await fetch(
            `${baseUrl}/api/workspaces/${payload.workspace_id}/threads/${payload.thread_id}/goal`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            },
          ),
        ),
      );
    },
    async clearThreadGoal(workspaceId: string, threadId: string) {
      return normalizeThreadSummary(
        await parseJson<ThreadSummary>(
          await fetch(
            `${baseUrl}/api/workspaces/${workspaceId}/threads/${threadId}/goal`,
            {
              method: "DELETE",
            },
          ),
        ),
      );
    },
    async markThreadRead(payload: MarkThreadReadPayload) {
      return normalizeThreadSummary(
        await parseJson<ThreadSummary>(
          await fetch(
            `${baseUrl}/api/workspaces/${payload.workspace_id}/threads/${payload.thread_id}/read`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ read_seq: payload.read_seq }),
            },
          ),
        ),
      );
    },
    async markThreadUnread(payload: MarkThreadUnreadPayload) {
      return normalizeThreadSummary(
        await parseJson<ThreadSummary>(
          await fetch(
            `${baseUrl}/api/workspaces/${payload.workspace_id}/threads/${payload.thread_id}/unread`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
            },
          ),
        ),
      );
    },
    async respondInteractive(
      workspaceId: string,
      requestId: string,
      response: InteractiveResponsePayload,
    ) {
      return parseJson<{ ok: boolean; message?: string | null }>(
        await fetch(
          `${baseUrl}/api/workspaces/${workspaceId}/interactive-requests/${requestId}/respond`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ response }),
          },
        ),
      );
    },
    // An isolated thread's changes live in its own checkout, so status and
    // diffs are asked per thread; omitting it reports the project folder.
    async gitStatus(workspaceId: string, threadId?: string | null) {
      const query = new URLSearchParams();
      if (threadId) query.set("thread_id", threadId);
      const params = query.toString() ? `?${query.toString()}` : "";
      return parseJson<GitStatusResponse>(
        await fetch(
          `${baseUrl}/api/workspaces/${workspaceId}/git/status${params}`,
        ),
      );
    },
    // Branches always describe the project folder: isolated-thread checkouts
    // are fixed at creation, so the picker only exists for new threads.
    async gitBranches(workspaceId: string) {
      return parseJson<GitBranchesResponse>(
        await fetch(`${baseUrl}/api/workspaces/${workspaceId}/git/branches`),
      );
    },
    async gitCheckout(workspaceId: string, branch: string, create = false) {
      return parseJson<GitBranchesResponse>(
        await fetch(`${baseUrl}/api/workspaces/${workspaceId}/git/checkout`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ branch, create }),
        }),
      );
    },
    async gitDiff(
      workspaceId: string,
      path?: string,
      status?: GitFileStatus | null,
      threadId?: string | null,
    ) {
      const query = new URLSearchParams();
      if (path) query.set("path", path);
      if (status) query.set("status", status);
      if (threadId) query.set("thread_id", threadId);
      const params = query.toString() ? `?${query.toString()}` : "";
      return parseJson<GitDiffResponse>(
        await fetch(
          `${baseUrl}/api/workspaces/${workspaceId}/git/diff${params}`,
        ),
      );
    },
    // Commits leftover work in an isolated thread's own checkout. The project
    // folder is never touched, so a dirty project stays untouched.
    async gitCommit(
      workspaceId: string,
      threadId: string,
      message?: string | null,
    ) {
      return parseJson<GitCommitResponse>(
        await fetch(`${baseUrl}/api/workspaces/${workspaceId}/git/commit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ thread_id: threadId, message }),
        }),
      );
    },
    // Lands an isolated thread: commit leftovers, then open a pull request or
    // merge into the base branch recorded when the checkout was created.
    async shipThread(
      workspaceId: string,
      threadId: string,
      mode: ShipThreadMode,
    ) {
      return parseJson<ShipThreadResponse>(
        await fetch(
          `${baseUrl}/api/workspaces/${workspaceId}/threads/${threadId}/ship`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode }),
          },
        ),
      );
    },
    async workspaceFiles(workspaceId: string, threadId?: string | null) {
      const query = new URLSearchParams();
      if (threadId) query.set("thread_id", threadId);
      const params = query.toString() ? `?${query.toString()}` : "";
      return parseJson<WorkspaceFilesResponse>(
        await fetch(`${baseUrl}/api/workspaces/${workspaceId}/files${params}`),
      );
    },
    async workspaceFile(
      workspaceId: string,
      path: string,
      threadId?: string | null,
    ) {
      const query = new URLSearchParams({ path });
      if (threadId) query.set("thread_id", threadId);
      return parseJson<WorkspaceFileResponse>(
        await fetch(
          `${baseUrl}/api/workspaces/${workspaceId}/files/content?${query.toString()}`,
        ),
      );
    },
    async writeWorkspaceFile(
      workspaceId: string,
      path: string,
      payload: WriteWorkspaceFilePayload,
      threadId?: string | null,
    ) {
      const query = new URLSearchParams({ path });
      if (threadId) query.set("thread_id", threadId);
      return parseJson<WorkspaceFileResponse>(
        await fetch(
          `${baseUrl}/api/workspaces/${workspaceId}/files/content?${query.toString()}`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          },
        ),
      );
    },
    async deleteThread(workspaceId: string, threadId: string) {
      return parseJson<{ ok: boolean; message?: string | null }>(
        await fetch(
          `${baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}`,
          { method: "DELETE" },
        ),
      );
    },
    connectEvents(onEvent: (event: EventEnvelope) => void) {
      const socket = new WebSocket(
        baseUrl.replace("http", "ws") + "/api/events",
      );
      socket.onmessage = (message) => {
        let event: EventEnvelope;
        try {
          event = normalizeEventEnvelope(
            JSON.parse(message.data) as EventEnvelope,
          );
        } catch {
          // A malformed frame must not throw inside onmessage and kill the stream.
          console.warn("Ignoring malformed daemon event frame");
          return;
        }
        onEvent(event);
      };
      return socket;
    },
  };
}

/** The client shape produced by `createDaemonApiClient`, for prop typing. */
export type DaemonApiClient = ReturnType<typeof createDaemonApiClient>;
