// Enrolled remote servers ("hosts"): persistence, per-host relay connections,
// and a DaemonApiClient-shaped adapter so App call sites can route thread and
// turn operations to whichever daemon owns the workspace. A host is another
// falcondeck-daemon enrolled through the relay — same protocol the mobile app
// speaks to this Mac, pointed the other way.
import {
  applyEventToThreadDetail,
  applySnapshotEvent,
  claimHostPairing,
  normalizeDaemonSnapshot,
  normalizeThreadDetail,
  normalizeThreadHandle,
  normalizeThreadSummary,
  RemoteHostClient,
  DEFAULT_REMOTE_RELAY_URL,
  type DaemonSnapshot,
  type EventEnvelope,
  type InteractiveResponsePayload,
  type MachinePresence,
  type MarkThreadReadPayload,
  type PersistedRemoteSession,
  type RemoteHostStatus,
  type SendTurnPayload,
  type SetThreadGoalPayload,
  type StartThreadPayload,
  type ThreadDetail,
  type ThreadHandle,
  type ThreadSummary,
  type UpdateThreadPayload,
  type WorkspaceSummary,
} from '@falcondeck/client-core'

const HOSTS_STORAGE_KEY = 'falcondeck.desktop.hosts.v1'

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
}

export function loadStoredHosts(): StoredHost[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(HOSTS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is StoredHost =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as StoredHost).id === 'string' &&
        typeof (entry as StoredHost).name === 'string',
    )
  } catch {
    return []
  }
}

export function saveStoredHosts(hosts: StoredHost[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(HOSTS_STORAGE_KEY, JSON.stringify(hosts))
  } catch {
    // Keep the in-memory list authoritative when storage fails.
  }
}

// The subset of the daemon API that App routes per-workspace. Matches
// createDaemonApiClient's method shapes so call sites can swap clients by
// workspace owner without branching on payload format.
export type WorkspaceScopedApi = {
  startThread(payload: StartThreadPayload): Promise<ThreadHandle>
  sendTurn(payload: SendTurnPayload): Promise<{ ok: boolean; message?: string | null }>
  interruptTurn(workspaceId: string, threadId: string): Promise<{ ok: boolean; message?: string | null }>
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
  updateThread(payload: UpdateThreadPayload): Promise<ThreadHandle>
  archiveThread(workspaceId: string, threadId: string): Promise<ThreadSummary>
  unarchiveThread(workspaceId: string, threadId: string): Promise<ThreadSummary>
  setThreadGoal(payload: SetThreadGoalPayload): Promise<ThreadSummary>
  clearThreadGoal(workspaceId: string, threadId: string): Promise<ThreadSummary>
  markThreadRead(payload: MarkThreadReadPayload): Promise<ThreadSummary>
  respondInteractive(
    workspaceId: string,
    requestId: string,
    response: InteractiveResponsePayload,
  ): Promise<{ ok: boolean; message?: string | null }>
  threadDetail(workspaceId: string, threadId: string): Promise<ThreadDetail>
  connectWorkspace(path: string): Promise<WorkspaceSummary>
  removeWorkspace(workspaceId: string): Promise<unknown>
}

export class HostConnection {
  host: StoredHost
  private client: RemoteHostClient | null = null
  snapshot: DaemonSnapshot | null = null
  status: RemoteHostStatus = 'idle'
  presence: MachinePresence | null = null
  lastError: string | null = null
  private readonly detailCache = new Map<string, ThreadDetail>()
  private readonly onChange: () => void
  private readonly onPersist: () => void

  constructor(host: StoredHost, onChange: () => void, onPersist: () => void) {
    this.host = host
    this.onChange = onChange
    this.onPersist = onPersist
  }

  get connected() {
    return this.status === 'encrypted' && (this.presence?.daemon_connected ?? false)
  }

  start() {
    if (this.client || !this.host.enabled || !this.host.session) return
    const client = new RemoteHostClient(this.host.session, {
      onStatusChange: (status) => {
        this.status = status
        if (status === 'encrypted') {
          this.lastError = null
          void this.refreshSnapshot()
        }
        this.onChange()
      },
      onPresence: (presence) => {
        this.presence = presence
        this.onChange()
      },
      onEvents: (events) => this.applyEvents(events),
      onHistoryTruncated: () => {
        this.snapshot = null
        this.detailCache.clear()
        void this.refreshSnapshot()
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
  }

  stop() {
    this.client?.stop()
    this.client = null
    this.status = 'idle'
    this.presence = null
    this.snapshot = null
    this.detailCache.clear()
    this.onChange()
  }

  private applyEvents(events: EventEnvelope[]) {
    for (const event of events) {
      this.snapshot = applySnapshotEvent(this.snapshot, event)
      if (event.workspace_id && event.thread_id) {
        const key = `${event.workspace_id}:${event.thread_id}`
        const cached = this.detailCache.get(key)
        if (cached) {
          const updated = applyEventToThreadDetail(cached, event)
          if (updated && updated !== cached) this.detailCache.set(key, updated)
        }
      }
    }
    this.onChange()
  }

  private async refreshSnapshot() {
    const client = this.client
    if (!client) return
    try {
      const raw = await client.rpc('snapshot.current', {})
      this.snapshot = normalizeDaemonSnapshot(raw)
      this.onChange()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Failed to load host snapshot'
      this.onChange()
    }
  }

  async threadDetail(workspaceId: string, threadId: string): Promise<ThreadDetail> {
    const key = `${workspaceId}:${threadId}`
    const client = this.client
    if (!client) throw new Error('Host is not connected')
    const detail = normalizeThreadDetail(
      await client.rpc('thread.detail', { workspaceId, threadId }),
    )
    this.detailCache.set(key, detail)
    this.onChange()
    return detail
  }

  cachedThreadDetail(workspaceId: string, threadId: string): ThreadDetail | null {
    return this.detailCache.get(`${workspaceId}:${threadId}`) ?? null
  }

  private rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const client = this.client
    if (!client) return Promise.reject(new Error('Host is not connected'))
    return client.rpc<T>(method, params)
  }

  api(): WorkspaceScopedApi {
    return {
      startThread: async (payload) =>
        normalizeThreadHandle(await this.rpc('thread.start', payload)),
      sendTurn: (payload) => this.rpc('turn.start', payload),
      interruptTurn: (workspaceId, threadId) =>
        this.rpc('turn.interrupt', { workspace_id: workspaceId, thread_id: threadId }),
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
      updateThread: async (payload) =>
        normalizeThreadHandle(await this.rpc('thread.update', payload)),
      archiveThread: async (workspaceId, threadId) =>
        normalizeThreadSummary(
          await this.rpc('thread.archive', { workspaceId, threadId }),
        ),
      unarchiveThread: async (workspaceId, threadId) =>
        normalizeThreadSummary(
          await this.rpc('thread.unarchive', { workspaceId, threadId }),
        ),
      setThreadGoal: async (payload) =>
        normalizeThreadSummary(await this.rpc('thread.goal.set', payload)),
      clearThreadGoal: async (workspaceId, threadId) =>
        normalizeThreadSummary(
          await this.rpc('thread.goal.clear', { workspaceId, threadId }),
        ),
      markThreadRead: async (payload) =>
        normalizeThreadSummary(await this.rpc('thread.mark_read', payload)),
      respondInteractive: (workspaceId, requestId, response) =>
        this.rpc('interactive.respond', {
          workspaceId,
          requestId,
          response,
        }),
      threadDetail: (workspaceId, threadId) => this.threadDetail(workspaceId, threadId),
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
      paired: this.host.session !== null,
      needsRepair: this.host.needsRepair ?? false,
      status: this.status,
      presence: this.presence,
      snapshot: this.snapshot,
      lastError: this.lastError,
    }
  }
}

export class HostManager {
  private connections = new Map<string, HostConnection>()
  private hosts: StoredHost[] = []
  private listeners = new Set<() => void>()

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

  private persist() {
    saveStoredHosts(this.hosts)
    this.notify()
  }

  start() {
    for (const host of this.hosts) {
      this.connectionFor(host).start()
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
        () => this.persist(),
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
    }
    this.hosts = [...this.hosts, host]
    const connection = this.connectionFor(host)
    connection.start()
    this.persist()
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
    this.connections.get(hostId)?.stop()
    this.connections.delete(hostId)
    host.session = session
    host.needsRepair = false
    host.enabled = true
    this.connectionFor(host).start()
    this.persist()
  }

  setEnabled(hostId: string, enabled: boolean) {
    const host = this.hosts.find((entry) => entry.id === hostId)
    if (!host) return
    host.enabled = enabled
    const connection = this.connectionFor(host)
    if (enabled) connection.start()
    else connection.stop()
    this.persist()
  }

  removeHost(hostId: string) {
    this.connections.get(hostId)?.stop()
    this.connections.delete(hostId)
    this.hosts = this.hosts.filter((entry) => entry.id !== hostId)
    this.persist()
  }

  renameHost(hostId: string, name: string) {
    const host = this.hosts.find((entry) => entry.id === hostId)
    if (!host) return
    host.name = name.trim() || host.name
    this.persist()
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
