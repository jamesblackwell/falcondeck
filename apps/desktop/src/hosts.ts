// Enrolled remote servers ("hosts"): persistence, per-host relay connections,
// and a DaemonApiClient-shaped adapter so App call sites can route thread and
// turn operations to whichever daemon owns the workspace. A host is another
// falcondeck-daemon enrolled through the relay — same protocol the mobile app
// speaks to this computer, pointed the other way.
import {
  applyEventToThreadDetail,
  applySnapshotEvent,
  claimHostPairing,
  isDaemonRpcReady,
  normalizeDaemonSnapshot,
  normalizeThreadDetail,
  normalizeSkillSummaries,
  normalizeThreadHandle,
  normalizeThreadSummary,
  mergeThreadDetailPage,
  removeConversationItem,
  upsertConversationItem,
  RemoteHostClient,
  DEFAULT_REMOTE_RELAY_URL,
  type ConversationItem,
  type CompactThreadPayload,
  type ControlExecuteRequest,
  type ControlExecuteResponse,
  type ControlGetRequest,
  type ControlGetResponse,
  type CreateScheduledTaskPayload,
  type DaemonSnapshot,
  type EventEnvelope,
  type ExtensionActionResponse,
  type ExtensionSnapshot,
  type GitCommitResponse,
  type GitDiffResponse,
  type GitFileStatus,
  type GitStatusResponse,
  type ShipThreadMode,
  type ShipThreadResponse,
  type InteractiveResponsePayload,
  type InvokeExtensionActionPayload,
  type MachinePresence,
  type MarkThreadReadPayload,
  type MarkThreadUnreadPayload,
  type PersistedRemoteSession,
  type RemoteHostStatus,
  type SendTurnPayload,
  type ScheduledTaskDetail,
  type ScheduledTaskRunSummary,
  type ScheduledTaskSummary,
  type SetThreadGoalPayload,
  type SkillSummary,
  type StartThreadPayload,
  type SuggestThreadTitleResponse,
  type ThreadDetail,
  type ThreadDetailRequest,
  type ThreadHandle,
  type ForkThreadPayload,
  type ThreadSummary,
  type UpdateThreadPayload,
  type UpdateScheduledTaskPayload,
  type WorkspaceSummary,
  type WorkspaceFileResponse,
  type WorkspaceFilesResponse,
  type WriteWorkspaceFilePayload,
} from '@falcondeck/client-core'
import { realtimeAudioPlayer } from '@falcondeck/chat-ui'

import { CONNECTION_COPY } from './connection-copy'

const HOSTS_STORAGE_KEY = 'falcondeck.desktop.hosts.v1'
const MAX_DETAIL_CACHE_ENTRIES = 50

export type StoredHost = {
  id: string
  name: string
  // SSH target used to provision/manage the server (alias or user@host).
  // Null for hosts enrolled by pasting a pairing code without SSH access.
  sshTarget: string | null
  sshPort: number | null
  relayUrl: string
  enabled: boolean
  session: PersistedRemoteSession | null
  /** Durable marker only; the credential itself lives in the OS keychain. */
  hasStoredSession?: boolean
  // Set when the relay rejected the saved credentials; the host needs
  // re-pairing.
  needsRepair?: boolean
}

export type HostView = {
  id: string
  name: string
  sshTarget: string | null
  sshPort: number | null
  relayUrl: string
  enabled: boolean
  paired: boolean
  needsRepair: boolean
  status: RemoteHostStatus
  presence: MachinePresence | null
  snapshot: DaemonSnapshot | null
  lastError: string | null
  /** Latest agent-control store revision observed on the host event stream. */
  controlRevision?: number
}

export function loadStoredHosts(): StoredHost[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(HOSTS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).id === 'string' &&
        typeof (entry as Record<string, unknown>).name === 'string',
      )
      .map((entry) => {
        // A pre-keychain installation may still contain the legacy session.
        // Keep it in memory only long enough for HostManager.start() to move
        // it into OS credential storage and rewrite this metadata record.
        const legacySession =
          typeof entry.session === 'object' && entry.session !== null
            ? (entry.session as PersistedRemoteSession)
            : null
        return {
          id: entry.id as string,
          name: entry.name as string,
          sshTarget: typeof entry.sshTarget === 'string' ? entry.sshTarget : null,
          sshPort: typeof entry.sshPort === 'number' ? entry.sshPort : null,
          relayUrl:
            typeof entry.relayUrl === 'string'
              ? entry.relayUrl
              : DEFAULT_REMOTE_RELAY_URL,
          enabled: entry.enabled !== false,
          session: legacySession,
          hasStoredSession: entry.hasSession === true || legacySession !== null,
          needsRepair: entry.needsRepair === true,
        }
      })
  } catch {
    return []
  }
}

export function saveStoredHosts(hosts: StoredHost[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      HOSTS_STORAGE_KEY,
      JSON.stringify(
        hosts.map(({ session, hasStoredSession, ...metadata }) => ({
          ...metadata,
          hasSession: hasStoredSession === true || session !== null,
        })),
      ),
    )
  } catch {
    // Keep the in-memory list authoritative when storage fails.
  }
}

async function writeSecureHostSession(
  hostId: string,
  session: PersistedRemoteSession,
) {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('write_host_session_secret', {
    hostId,
    payload: JSON.stringify(session),
  })
}

async function readSecureHostSession(hostId: string) {
  const { invoke } = await import('@tauri-apps/api/core')
  const payload = await invoke<string | null>('read_host_session_secret', {
    hostId,
  })
  if (!payload) return null
  const parsed = JSON.parse(payload) as unknown
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Stored server credentials are invalid.')
  }
  return parsed as PersistedRemoteSession
}

async function deleteSecureHostSession(hostId: string) {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('delete_host_session_secret', { hostId })
}

// The subset of the daemon API that App routes per-workspace. Matches
// createDaemonApiClient's method shapes so call sites can swap clients by
// workspace owner without branching on payload format.
export type WorkspaceScopedApi = {
  invokeExtensionAction(
    extensionId: string,
    actionId: string,
    payload: InvokeExtensionActionPayload,
  ): Promise<ExtensionActionResponse>
  startThread(payload: StartThreadPayload): Promise<ThreadHandle>
  forkThread(payload: ForkThreadPayload): Promise<ThreadHandle>
  sendTurn(payload: SendTurnPayload): Promise<{ ok: boolean; message?: string | null }>
  compactThread(payload: CompactThreadPayload): Promise<{ ok: boolean; message?: string | null }>
  interruptTurn(workspaceId: string, threadId: string): Promise<{ ok: boolean; message?: string | null }>
  hydrateProvider(workspaceId: string, provider: string): Promise<{ ok: boolean; message?: string | null }>
  listWorkspaceSkills(workspaceId: string, provider?: string | null): Promise<SkillSummary[]>
  removeQueuedTurn(
    workspaceId: string,
    threadId: string,
    queuedId: string,
  ): Promise<{ ok: boolean; message?: string | null }>
  steerQueuedTurn(
    workspaceId: string,
    threadId: string,
    queuedId: string,
  ): Promise<{ ok: boolean; message?: string | null }>
  editQueuedTurn(
    workspaceId: string,
    threadId: string,
    queuedId: string,
    text: string,
  ): Promise<{ ok: boolean; message?: string | null }>
  reorderQueuedTurns(
    workspaceId: string,
    threadId: string,
    queuedIds: string[],
  ): Promise<{ ok: boolean; message?: string | null }>
  updateThread(payload: UpdateThreadPayload): Promise<ThreadHandle>
  suggestThreadTitle(workspaceId: string, threadId: string): Promise<SuggestThreadTitleResponse>
  archiveThread(workspaceId: string, threadId: string): Promise<ThreadSummary>
  unarchiveThread(workspaceId: string, threadId: string): Promise<ThreadSummary>
  deleteThread(workspaceId: string, threadId: string): Promise<{ ok: boolean; message?: string | null }>
  setThreadGoal(payload: SetThreadGoalPayload): Promise<ThreadSummary>
  clearThreadGoal(workspaceId: string, threadId: string): Promise<ThreadSummary>
  markThreadRead(payload: MarkThreadReadPayload): Promise<ThreadSummary>
  markThreadUnread(payload: MarkThreadUnreadPayload): Promise<ThreadSummary>
  respondInteractive(
    workspaceId: string,
    requestId: string,
    response: InteractiveResponsePayload,
  ): Promise<{ ok: boolean; message?: string | null }>
  threadDetail(
    workspaceId: string,
    threadId: string,
    request?: Omit<ThreadDetailRequest, 'workspace_id' | 'thread_id'>,
  ): Promise<ThreadDetail>
  connectWorkspace(path: string): Promise<WorkspaceSummary>
  removeWorkspace(workspaceId: string): Promise<unknown>
  closeWorkspace(workspaceId: string): Promise<unknown>
  gitStatus(workspaceId: string, threadId?: string | null): Promise<GitStatusResponse>
  gitCommit(
    workspaceId: string,
    threadId: string,
    message?: string | null,
  ): Promise<GitCommitResponse>
  shipThread(
    workspaceId: string,
    threadId: string,
    mode: ShipThreadMode,
  ): Promise<ShipThreadResponse>
  gitDiff(
    workspaceId: string,
    path?: string,
    status?: GitFileStatus | null,
    threadId?: string | null,
  ): Promise<GitDiffResponse>
  workspaceFiles(workspaceId: string, threadId?: string | null): Promise<WorkspaceFilesResponse>
  workspaceFile(
    workspaceId: string,
    path: string,
    threadId?: string | null,
  ): Promise<WorkspaceFileResponse>
  writeWorkspaceFile(
    workspaceId: string,
    path: string,
    payload: WriteWorkspaceFilePayload,
    threadId?: string | null,
  ): Promise<WorkspaceFileResponse>
}

export type HostScopedApi = {
  scheduledTasks(): Promise<ScheduledTaskSummary[]>
  scheduledTask(taskId: string): Promise<ScheduledTaskDetail>
  createScheduledTask(payload: CreateScheduledTaskPayload): Promise<ScheduledTaskDetail>
  updateScheduledTask(
    taskId: string,
    payload: UpdateScheduledTaskPayload,
  ): Promise<ScheduledTaskDetail>
  deleteScheduledTask(taskId: string): Promise<{ ok: boolean; message?: string | null }>
  runScheduledTask(taskId: string): Promise<ScheduledTaskRunSummary>
  scheduledTaskRuns(taskId: string): Promise<ScheduledTaskRunSummary[]>
  controlGet(request: ControlGetRequest): Promise<ControlGetResponse>
  controlExecute(request: ControlExecuteRequest): Promise<ControlExecuteResponse>
}

export class HostConnection {
  host: StoredHost
  private client: RemoteHostClient | null = null
  snapshot: DaemonSnapshot | null = null
  status: RemoteHostStatus = 'idle'
  presence: MachinePresence | null = null
  lastError: string | null = null
  private controlRevision = 0
  private readonly detailCache = new Map<string, ThreadDetail>()
  private readonly onChange: () => void
  private readonly onPersist: () => void
  private snapshotRequestInFlight = false
  private snapshotRefreshPromise: Promise<void> | null = null
  private lifecycleGeneration = 0
  private pendingSnapshotEvents: Array<{
    events: EventEnvelope[]
    resolve: () => void
    reject: (error: Error) => void
  }> = []

  constructor(host: StoredHost, onChange: () => void, onPersist: () => void) {
    this.host = host
    this.onChange = onChange
    this.onPersist = onPersist
  }

  private cachedDetail(key: string): ThreadDetail | undefined {
    const detail = this.detailCache.get(key)
    if (detail) {
      this.detailCache.delete(key)
      this.detailCache.set(key, detail)
    }
    return detail
  }

  private cacheDetail(key: string, detail: ThreadDetail) {
    this.detailCache.delete(key)
    this.detailCache.set(key, detail)
    while (this.detailCache.size > MAX_DETAIL_CACHE_ENTRIES) {
      const oldest = this.detailCache.keys().next().value
      if (oldest === undefined) break
      this.detailCache.delete(oldest)
    }
  }

  get connected() {
    return this.status === 'encrypted' && (this.presence?.daemon_connected ?? false)
  }

  start() {
    if (this.client || !this.host.enabled || !this.host.session) return
    let client: RemoteHostClient | null = null
    try {
      client = new RemoteHostClient(this.host.session, {
        onStatusChange: (status) => {
          this.status = status
          if (status === 'encrypted') {
            this.lastError = null
            if (isDaemonRpcReady(this.presence)) {
              void this.refreshSnapshot().catch(() => {})
            }
          }
          this.onChange()
        },
        onPresence: (presence) => {
          const becameReady =
            !isDaemonRpcReady(this.presence) && isDaemonRpcReady(presence)
          this.presence = presence
          if (becameReady && this.status === 'encrypted' && !this.snapshot) {
            void this.refreshSnapshot().catch(() => {})
          }
          this.onChange()
        },
        onEvents: (events) => this.applyEventsWithSnapshotBarrier(events),
        onHistoryTruncated: async () => {
          this.snapshot = null
          this.detailCache.clear()
          this.onChange()
          await this.refreshSnapshot()
        },
        onSessionChanged: (session) => {
          this.host.session = session
          this.onPersist()
        },
        onError: (message) => {
          this.lastError = message
          this.onChange()
        },
        onInvalidSession: (message) => {
          this.lastError = message
          this.host.needsRepair = true
          this.client = null
          this.status = 'idle'
          this.snapshot = null
          this.onPersist()
          this.onChange()
        },
      })
      this.client = client
      client.start()
    } catch {
      client?.stop()
      this.client = null
      this.status = 'idle'
      this.presence = null
      this.snapshot = null
      this.host.needsRepair = true
      this.lastError = 'Stored server credentials are invalid. Repair this server to reconnect.'
      this.onPersist()
      this.onChange()
    }
  }

  stop() {
    this.lifecycleGeneration += 1
    this.client?.stop()
    this.client = null
    this.status = 'idle'
    this.presence = null
    this.snapshot = null
    this.detailCache.clear()
    const stopError = new Error('Host connection stopped')
    for (const pending of this.pendingSnapshotEvents.splice(0)) {
      pending.reject(stopError)
    }
    this.snapshotRequestInFlight = false
    this.snapshotRefreshPromise = null
    this.onChange()
  }

  private applyEvents(events: EventEnvelope[]) {
    for (const event of events) {
      realtimeAudioPlayer.handleEvent(event)
      this.snapshot = applySnapshotEvent(this.snapshot, event)
      if (event.event.type === 'control-state-changed') {
        this.controlRevision = event.event.change.store_revision
      }
      if (event.workspace_id && event.thread_id) {
        const key = `${event.workspace_id}:${event.thread_id}`
        const cached = this.cachedDetail(key)
        if (cached) {
          const updated = applyEventToThreadDetail(cached, event)
          if (updated && updated !== cached) this.cacheDetail(key, updated)
        }
      }
    }
    this.onChange()
  }

  private applyEventsWithSnapshotBarrier(events: EventEnvelope[]): Promise<void> {
    if (!this.snapshotRequestInFlight) {
      this.applyEvents(events)
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      this.pendingSnapshotEvents.push({ events, resolve, reject })
    })
  }

  private refreshSnapshot(): Promise<void> {
    if (this.snapshotRefreshPromise) return this.snapshotRefreshPromise
    const client = this.client
    if (!client) return Promise.resolve()
    const generation = this.lifecycleGeneration
    const isCurrent = () =>
      generation === this.lifecycleGeneration && client === this.client

    this.snapshotRequestInFlight = true
    const refresh = (async () => {
      try {
        const raw = await client.rpc('snapshot.current', {})
        if (!isCurrent()) return
        this.snapshot = normalizeDaemonSnapshot(raw)
        this.onChange()
        const pending = this.pendingSnapshotEvents.splice(0)
        for (const entry of pending) {
          this.applyEvents(entry.events)
          entry.resolve()
        }
      } catch (error) {
        if (!isCurrent()) return
        const reason = error instanceof Error ? error : new Error('Failed to load host snapshot')
        this.lastError = reason.message
        this.onChange()
        for (const entry of this.pendingSnapshotEvents.splice(0)) {
          entry.reject(reason)
        }
        throw reason
      } finally {
        if (isCurrent()) this.snapshotRequestInFlight = false
      }
    })()
    this.snapshotRefreshPromise = refresh
    refresh.then(
      () => {
        if (this.snapshotRefreshPromise === refresh) this.snapshotRefreshPromise = null
      },
      () => {
        if (this.snapshotRefreshPromise === refresh) this.snapshotRefreshPromise = null
      },
    )
    return refresh
  }

  refresh(): Promise<void> {
    return this.refreshSnapshot()
  }

  async threadDetail(
    workspaceId: string,
    threadId: string,
    request: Omit<ThreadDetailRequest, 'workspace_id' | 'thread_id'> = {},
  ): Promise<ThreadDetail> {
    const key = `${workspaceId}:${threadId}`
    const client = this.client
    if (!client) throw new Error(CONNECTION_COPY.serverNotConnected)
    const page = normalizeThreadDetail(
      await client.rpc('thread.detail', {
        workspace_id: workspaceId,
        thread_id: threadId,
        ...request,
      }),
    )
    const current = this.cachedDetail(key)
    if (
      request.mode === 'before' &&
      current &&
      current.oldest_item_id !== request.before_item_id
    ) {
      return current
    }
    const detail = request.mode === 'before'
      ? mergeThreadDetailPage(current, page, 'prepend')
      : request.mode === 'tail'
        ? mergeThreadDetailPage(current, page, 'refresh')
        : page
    this.cacheDetail(key, detail)
    this.onChange()
    return detail
  }

  cachedThreadDetail(workspaceId: string, threadId: string): ThreadDetail | null {
    return this.cachedDetail(`${workspaceId}:${threadId}`) ?? null
  }

  /**
   * Seeds the cache for a just-created thread so the detail effect renders it
   * without a loading state (and doesn't null the transcript while fetching).
   * A cache entry that already exists wins — it may hold streamed items.
   */
  seedThreadDetail(detail: ThreadDetail) {
    const key = `${detail.workspace.id}:${detail.thread.id}`
    if (this.detailCache.has(key)) return
    this.cacheDetail(key, detail)
    this.onChange()
  }

  /**
   * Inserts a client-local (optimistic) item into the cached transcript. The
   * cache is authoritative for remote threads — App-level state is re-synced
   * from it on every host notification — so an optimistic item must live here
   * to survive until the daemon's echo replaces it by id.
   */
  upsertLocalItem(workspaceId: string, threadId: string, item: ConversationItem) {
    const key = `${workspaceId}:${threadId}`
    const cached = this.cachedDetail(key)
    if (!cached) return
    const items = upsertConversationItem(cached.items, item)
    this.cacheDetail(key, {
      ...cached,
      items,
      oldest_item_id: items[0]?.id ?? cached.oldest_item_id,
      newest_item_id: items.at(-1)?.id ?? cached.newest_item_id,
    })
    this.onChange()
  }

  /** Removes a client-local item again (send failed or landed in the queue). */
  removeLocalItem(workspaceId: string, threadId: string, itemId: string) {
    const key = `${workspaceId}:${threadId}`
    const cached = this.cachedDetail(key)
    if (!cached) return
    const items = removeConversationItem(cached.items, itemId)
    if (items === cached.items) return
    this.cacheDetail(key, {
      ...cached,
      items,
      oldest_item_id: items[0]?.id ?? null,
      newest_item_id: items.at(-1)?.id ?? null,
    })
    this.onChange()
  }

  private rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const client = this.client
    if (!client) return Promise.reject(new Error(CONNECTION_COPY.serverNotConnected))
    return client.rpc<T>(method, params)
  }

  api(): WorkspaceScopedApi {
    return {
      invokeExtensionAction: async (extensionId, actionId, payload) => {
        const result = await this.rpc<ExtensionActionResponse>(
          'extensions.action.invoke',
          {
            extension_id: extensionId,
            action_id: actionId,
            ...payload,
          },
        )
        await this.refreshSnapshot()
        return result
      },
      startThread: async (payload) =>
        normalizeThreadHandle(await this.rpc('thread.start', payload)),
      forkThread: async (payload) =>
        normalizeThreadHandle(await this.rpc('thread.fork', payload)),
      sendTurn: (payload) => this.rpc('turn.start', payload),
      compactThread: (payload) => this.rpc('thread.compact', payload),
      interruptTurn: (workspaceId, threadId) =>
        this.rpc('turn.interrupt', { workspace_id: workspaceId, thread_id: threadId }),
      hydrateProvider: (workspaceId, provider) =>
        this.rpc('provider.hydrate', { workspace_id: workspaceId, provider }),
      listWorkspaceSkills: async (workspaceId, provider) => {
        const payload = await this.rpc<{ skills?: SkillSummary[] }>('workspace.skills', {
          workspace_id: workspaceId,
          ...(provider ? { provider } : {}),
        })
        return normalizeSkillSummaries(payload.skills)
      },
      removeQueuedTurn: (workspaceId, threadId, queuedId) =>
        this.rpc('thread.queue.remove', {
          workspace_id: workspaceId,
          thread_id: threadId,
          queued_id: queuedId,
        }),
      steerQueuedTurn: (workspaceId, threadId, queuedId) =>
        this.rpc('thread.queue.steer', {
          workspace_id: workspaceId,
          thread_id: threadId,
          queued_id: queuedId,
        }),
      editQueuedTurn: (workspaceId, threadId, queuedId, text) =>
        this.rpc('thread.queue.edit', {
          workspace_id: workspaceId,
          thread_id: threadId,
          queued_id: queuedId,
          text,
        }),
      reorderQueuedTurns: (workspaceId, threadId, queuedIds) =>
        this.rpc('thread.queue.reorder', {
          workspace_id: workspaceId,
          thread_id: threadId,
          queued_ids: queuedIds,
        }),
      updateThread: async (payload) =>
        normalizeThreadHandle(await this.rpc('thread.update', payload)),
      suggestThreadTitle: async (workspaceId, threadId) =>
        this.rpc<SuggestThreadTitleResponse>('thread.suggestTitle', {
          workspace_id: workspaceId,
          thread_id: threadId,
        }),
      archiveThread: async (workspaceId, threadId) =>
        normalizeThreadSummary(
          await this.rpc('thread.archive', { workspaceId, threadId }),
        ),
      unarchiveThread: async (workspaceId, threadId) =>
        normalizeThreadSummary(
          await this.rpc('thread.unarchive', { workspaceId, threadId }),
        ),
      deleteThread: async (workspaceId, threadId) => {
        const result = await this.rpc<{ ok: boolean; message?: string | null }>('thread.delete', {
          workspaceId,
          threadId,
        })
        this.detailCache.delete(`${workspaceId}:${threadId}`)
        await this.refreshSnapshot()
        return result
      },
      setThreadGoal: async (payload) =>
        normalizeThreadSummary(await this.rpc('thread.goal.set', payload)),
      clearThreadGoal: async (workspaceId, threadId) =>
        normalizeThreadSummary(
          await this.rpc('thread.goal.clear', { workspaceId, threadId }),
        ),
      markThreadRead: async (payload) =>
        normalizeThreadSummary(await this.rpc('thread.mark_read', payload)),
      markThreadUnread: async (payload) =>
        normalizeThreadSummary(await this.rpc('thread.mark_unread', payload)),
      respondInteractive: (workspaceId, requestId, response) =>
        this.rpc('interactive.respond', {
          workspaceId,
          requestId,
          response,
        }),
      threadDetail: (workspaceId, threadId, request) =>
        this.threadDetail(workspaceId, threadId, request),
      connectWorkspace: async (path) => {
        const workspace = (await this.rpc('workspace.connect', { path })) as WorkspaceSummary
        await this.refreshSnapshot()
        return workspace
      },
      removeWorkspace: async (workspaceId) => {
        const result = await this.rpc('workspace.remove', { workspaceId })
        await this.refreshSnapshot()
        return result
      },
      closeWorkspace: async (workspaceId) => {
        const result = await this.rpc('workspace.close', { workspaceId })
        await this.refreshSnapshot()
        return result
      },
      gitStatus: (workspaceId, threadId) =>
        this.rpc('git.status', { workspace_id: workspaceId, thread_id: threadId }),
      gitCommit: (workspaceId, threadId, message) =>
        this.rpc('git.commit', {
          workspace_id: workspaceId,
          thread_id: threadId,
          message,
        }),
      shipThread: (workspaceId, threadId, mode) =>
        this.rpc('thread.ship', {
          workspace_id: workspaceId,
          thread_id: threadId,
          mode,
        }),
      gitDiff: (workspaceId, path, status, threadId) =>
        this.rpc('git.diff', {
          workspace_id: workspaceId,
          path,
          status,
          thread_id: threadId,
        }),
      workspaceFiles: (workspaceId, threadId) =>
        this.rpc('workspace.files', { workspace_id: workspaceId, thread_id: threadId }),
      workspaceFile: (workspaceId, path, threadId) =>
        this.rpc('workspace.file.read', {
          workspace_id: workspaceId,
          path,
          thread_id: threadId,
        }),
      writeWorkspaceFile: (workspaceId, path, payload, threadId) =>
        this.rpc('workspace.file.write', {
          workspace_id: workspaceId,
          path,
          content: payload.content,
          expected_version: payload.expected_version,
          thread_id: threadId,
        }),
    }
  }

  scheduledApi(): HostScopedApi {
    return {
      scheduledTasks: () => this.rpc('scheduled.list', {}),
      scheduledTask: (taskId) => this.rpc('scheduled.detail', { task_id: taskId }),
      createScheduledTask: (payload) => this.rpc('scheduled.create', payload),
      updateScheduledTask: (taskId, payload) =>
        this.rpc('scheduled.update', { task_id: taskId, patch: payload }),
      deleteScheduledTask: (taskId) => this.rpc('scheduled.delete', { task_id: taskId }),
      runScheduledTask: (taskId) => this.rpc('scheduled.run', { task_id: taskId }),
      scheduledTaskRuns: (taskId) => this.rpc('scheduled.runs', { task_id: taskId }),
      controlGet: (request) => this.rpc('control.get', request),
      controlExecute: (request) => this.rpc('control.execute', request),
    }
  }

  view(): HostView {
    return {
      id: this.host.id,
      name: this.host.name,
      sshTarget: this.host.sshTarget,
      sshPort: this.host.sshPort,
      relayUrl: this.host.relayUrl,
      enabled: this.host.enabled,
      paired: this.host.session !== null || this.host.hasStoredSession === true,
      needsRepair: this.host.needsRepair ?? false,
      status: this.status,
      presence: this.presence,
      snapshot: this.snapshot,
      lastError: this.lastError,
      controlRevision: this.controlRevision,
    }
  }
}

export class HostManager {
  private connections = new Map<string, HostConnection>()
  private hosts: StoredHost[] = []
  private listeners = new Set<() => void>()
  private startPromise: Promise<void> | null = null

  constructor() {
    this.hosts = loadStoredHosts()
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify() {
    for (const listener of this.listeners) listener()
  }

  private persistMetadata() {
    saveStoredHosts(this.hosts)
    this.notify()
  }

  start() {
    this.startPromise ??= this.startSecureConnections()
  }

  private async startSecureConnections() {
    for (const host of this.hosts) {
      try {
        if (host.session) {
          await writeSecureHostSession(host.id, host.session)
          host.hasStoredSession = true
        } else if (host.hasStoredSession) {
          host.session = await readSecureHostSession(host.id)
          if (!host.session) host.needsRepair = true
        }
      } catch (error) {
        host.needsRepair = true
        const connection = this.connectionFor(host)
        connection.lastError =
          error instanceof Error
            ? error.message
            : 'Could not load server credentials from OS storage.'
      }
    }
    // This also removes any successfully migrated legacy session from
    // localStorage. No secret-bearing object is serialized here.
    this.persistMetadata()
    for (const host of this.hosts) this.connectionFor(host).start()
  }

  private async persistSession(host: StoredHost) {
    try {
      if (host.session) {
        await writeSecureHostSession(host.id, host.session)
        host.hasStoredSession = true
      } else {
        await deleteSecureHostSession(host.id)
        host.hasStoredSession = false
      }
      this.persistMetadata()
    } catch (error) {
      const connection = this.connectionFor(host)
      connection.lastError =
        error instanceof Error
          ? error.message
          : 'Could not save server credentials to OS storage.'
      this.notify()
    }
  }

  stopAll() {
    for (const connection of this.connections.values()) connection.stop()
    this.connections.clear()
  }

  private connectionFor(host: StoredHost): HostConnection {
    let connection = this.connections.get(host.id)
    if (!connection) {
      connection = new HostConnection(
        host,
        () => this.notify(),
        () => {
          void this.persistSession(host)
        },
      )
      this.connections.set(host.id, connection)
    }
    return connection
  }

  views(): HostView[] {
    return this.hosts.map((host) => this.connectionFor(host).view())
  }

  hostForWorkspace(workspaceId: string): HostConnection | null {
    for (const connection of this.connections.values()) {
      if (connection.snapshot?.workspaces.some((workspace) => workspace.id === workspaceId)) {
        return connection
      }
    }
    return null
  }

  connection(hostId: string): HostConnection | null {
    return this.connections.get(hostId) ?? null
  }

  // Enroll a server from a pairing code minted by its daemon. `sshTarget`
  // is remembered when provisioning ran over SSH so restart/uninstall work
  // later; pasting a code from elsewhere leaves it null.
  async addHost(options: {
    name: string
    pairingCode: string
    relayUrl?: string | null
    sshTarget?: string | null
    sshPort?: number | null
  }): Promise<HostView> {
    const relayUrl = options.relayUrl?.trim() || DEFAULT_REMOTE_RELAY_URL
    const session = await claimHostPairing({
      relayUrl,
      pairingCode: options.pairingCode,
      deviceLabel: 'FalconDeck Desktop',
    })
    const host: StoredHost = {
      id: `host-${crypto.randomUUID()}`,
      name: options.name.trim() || options.sshTarget || 'Server',
      sshTarget: options.sshTarget ?? null,
      sshPort: options.sshPort ?? null,
      relayUrl,
      enabled: true,
      session,
      hasStoredSession: true,
    }
    await writeSecureHostSession(host.id, session)
    this.hosts = [...this.hosts, host]
    const connection = this.connectionFor(host)
    connection.start()
    this.persistMetadata()
    return connection.view()
  }

  // Re-pair an existing host with a fresh code, keeping its identity/config.
  async repairHost(hostId: string, pairingCode: string): Promise<void> {
    const host = this.hosts.find((entry) => entry.id === hostId)
    if (!host) throw new Error('Unknown server')
    const session = await claimHostPairing({
      relayUrl: host.relayUrl,
      pairingCode,
      deviceLabel: 'FalconDeck Desktop',
    })
    await writeSecureHostSession(host.id, session)
    this.connections.get(hostId)?.stop()
    this.connections.delete(hostId)
    host.session = session
    host.hasStoredSession = true
    host.needsRepair = false
    host.enabled = true
    this.connectionFor(host).start()
    this.persistMetadata()
  }

  setEnabled(hostId: string, enabled: boolean) {
    const host = this.hosts.find((entry) => entry.id === hostId)
    if (!host) return
    host.enabled = enabled
    const connection = this.connectionFor(host)
    if (enabled) connection.start()
    else connection.stop()
    this.persistMetadata()
  }

  removeHost(hostId: string) {
    this.connections.get(hostId)?.stop()
    this.connections.delete(hostId)
    this.hosts = this.hosts.filter((entry) => entry.id !== hostId)
    this.persistMetadata()
    void deleteSecureHostSession(hostId)
  }

  renameHost(hostId: string, name: string) {
    const host = this.hosts.find((entry) => entry.id === hostId)
    if (!host) return
    host.name = name.trim() || host.name
    this.persistMetadata()
  }
}

// Merge remote host snapshots into the local daemon snapshot so the existing
// sidebar/selection/composer logic sees one world. Local state wins the
// daemon/preferences fields; hosts contribute workspaces, threads, and
// interactive requests.
export function mergeSnapshots(
  local: DaemonSnapshot | null,
  hosts: HostView[],
): DaemonSnapshot | null {
  const hostSnapshots = hosts
    .map((host) => host.snapshot)
    .filter((snapshot): snapshot is DaemonSnapshot => snapshot !== null)
  if (hostSnapshots.length === 0) return local
  const base = local ?? hostSnapshots[0]
  if (!base) return null
  return {
    ...base,
    workspaces: [
      ...(local?.workspaces ?? []),
      ...hostSnapshots.flatMap((snapshot) => snapshot.workspaces),
    ],
    threads: [
      ...(local?.threads ?? []),
      ...hostSnapshots.flatMap((snapshot) => snapshot.threads),
    ],
    interactive_requests: [
      ...(local?.interactive_requests ?? []),
      ...hostSnapshots.flatMap((snapshot) => snapshot.interactive_requests),
    ],
    service_notices: [
      ...(local?.service_notices ?? []),
      ...hostSnapshots.flatMap((snapshot) => snapshot.service_notices ?? []),
    ],
    operational_conditions: [
      ...(local?.operational_conditions ?? []),
      ...hostSnapshots.flatMap(
        (snapshot) => snapshot.operational_conditions ?? [],
      ),
    ],
    // Preserve the first owner of a thread id (local first, then host order).
    // Thread/workspace routing still uses the owning snapshot; allowing a
    // later host to overwrite only the token projection made the sidebar
    // display usage from a different machine for same-id restored sessions.
    thread_token_usage: mergeThreadTokenUsage([
      ...(local ? [local.thread_token_usage ?? {}] : []),
      ...hostSnapshots.map((snapshot) => snapshot.thread_token_usage ?? {}),
    ]),
    extensions: mergeExtensionSnapshots([
      ...(local ? [local.extensions] : []),
      ...hostSnapshots.map((snapshot) => snapshot.extensions),
    ]),
  }
}

type ThreadTokenUsageMap = NonNullable<DaemonSnapshot['thread_token_usage']>

function mergeThreadTokenUsage(maps: ThreadTokenUsageMap[]): ThreadTokenUsageMap {
  const merged: ThreadTokenUsageMap = {}
  for (const usage of maps) {
    for (const [threadId, value] of Object.entries(usage)) {
      if (!(threadId in merged)) merged[threadId] = value
    }
  }
  return merged
}

function mergeExtensionSnapshots(
  snapshots: ExtensionSnapshot[],
): ExtensionSnapshot {
  const catalog = new Map<string, ExtensionSnapshot['catalog'][number]>()
  const views = new Map<string, ExtensionSnapshot['views'][number]>()

  for (const snapshot of snapshots) {
    const enabledExtensionIds = new Set(
      snapshot.catalog
        .filter((extension) => extension.enabled)
        .map((extension) => extension.id),
    )
    for (const extension of snapshot.catalog) {
      const existing = catalog.get(extension.id)
      if (!existing || (!existing.enabled && extension.enabled)) {
        catalog.set(extension.id, extension)
      }
    }
    for (const view of snapshot.views) {
      if (!enabledExtensionIds.has(view.extension_id)) continue
      const scope = view.scope
        ? `${view.scope.kind}:${view.scope.id}`
        : 'global'
      views.set(`${view.extension_id}:${view.view_id}:${scope}`, view)
    }
  }

  return {
    catalog: [...catalog.values()],
    views: [...views.values()],
  }
}

export function hostLabelByWorkspaceId(hosts: HostView[]): Map<string, HostView> {
  const index = new Map<string, HostView>()
  for (const host of hosts) {
    for (const workspace of host.snapshot?.workspaces ?? []) {
      index.set(workspace.id, host)
    }
  }
  return index
}
