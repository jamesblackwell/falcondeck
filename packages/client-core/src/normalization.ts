import type {
  AccountSummary,
  AgentProvider,
  DaemonSnapshot,
  EventEnvelope,
  ThreadHandle,
  ThreadAgentParams,
  ThreadDetail,
  ThreadSummary,
  WorkspaceAgentSummary,
  WorkspaceSummary,
} from './types'

const DEFAULT_ACCOUNT: AccountSummary = {
  status: 'unknown',
  label: 'Unavailable',
}

const DEFAULT_THREAD_AGENT: ThreadAgentParams = {
  model_id: null,
  reasoning_effort: null,
  collaboration_mode_id: null,
  approval_policy: null,
  service_tier: null,
}

function normalizeProvider(value: unknown): AgentProvider {
  return value === 'claude' ? 'claude' : 'codex'
}

function normalizeAccount(value: unknown): AccountSummary {
  if (!value || typeof value !== 'object') {
    return DEFAULT_ACCOUNT
  }

  const account = value as Partial<AccountSummary>
  return {
    status:
      account.status === 'ready' || account.status === 'needs_auth'
        ? account.status
        : 'unknown',
    label:
      typeof account.label === 'string' && account.label.trim().length > 0
        ? account.label
        : DEFAULT_ACCOUNT.label,
  }
}

function normalizeThreadAgent(value: unknown): ThreadAgentParams {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_THREAD_AGENT }
  }

  const agent = value as Partial<ThreadAgentParams>
  return {
    model_id: agent.model_id ?? null,
    reasoning_effort: agent.reasoning_effort ?? null,
    collaboration_mode_id: agent.collaboration_mode_id ?? null,
    approval_policy: agent.approval_policy ?? null,
    service_tier: agent.service_tier ?? null,
  }
}

function fallbackWorkspaceAgent(workspace: Partial<WorkspaceSummary>): WorkspaceAgentSummary {
  return {
    provider: 'codex',
    account: normalizeAccount(workspace.account),
    models: workspace.models ?? [],
    collaboration_modes: workspace.collaboration_modes ?? [],
    supports_plan_mode: workspace.supports_plan_mode ?? true,
    supports_native_plan_mode: workspace.supports_native_plan_mode ?? true,
    capabilities: { supports_review: true },
  }
}

function normalizeWorkspaceAgent(
  value: unknown,
  fallback: Partial<WorkspaceSummary>,
): WorkspaceAgentSummary {
  if (!value || typeof value !== 'object') {
    return fallbackWorkspaceAgent(fallback)
  }

  const agent = value as Partial<WorkspaceAgentSummary>
  return {
    provider: normalizeProvider(agent.provider),
    account: normalizeAccount(agent.account),
    models: agent.models ?? [],
    collaboration_modes: agent.collaboration_modes ?? [],
    supports_plan_mode: agent.supports_plan_mode ?? true,
    supports_native_plan_mode: agent.supports_native_plan_mode ?? true,
    capabilities: {
      supports_review: agent.capabilities?.supports_review ?? false,
    },
  }
}

export function normalizeThreadSummary(value: ThreadSummary | unknown): ThreadSummary {
  const thread = (value ?? {}) as Partial<ThreadSummary> & {
    codex?: Partial<ThreadAgentParams> | null
  }

  return {
    id: thread.id ?? '',
    workspace_id: thread.workspace_id ?? '',
    title: thread.title ?? 'Untitled thread',
    provider: normalizeProvider(thread.provider),
    native_session_id: thread.native_session_id ?? null,
    status: thread.status ?? 'idle',
    updated_at: thread.updated_at ?? new Date(0).toISOString(),
    last_message_preview: thread.last_message_preview ?? null,
    latest_turn_id: thread.latest_turn_id ?? null,
    latest_plan: thread.latest_plan ?? null,
    latest_diff: thread.latest_diff ?? null,
    last_tool: thread.last_tool ?? null,
    last_error: thread.last_error ?? null,
    agent: normalizeThreadAgent(thread.agent ?? thread.codex),
    attention: {
      level: thread.attention?.level ?? 'none',
      badge_label: thread.attention?.badge_label ?? null,
      unread: thread.attention?.unread ?? false,
      pending_approval_count: thread.attention?.pending_approval_count ?? 0,
      pending_question_count: thread.attention?.pending_question_count ?? 0,
      last_agent_activity_seq: thread.attention?.last_agent_activity_seq ?? 0,
      last_read_seq: thread.attention?.last_read_seq ?? 0,
    },
    is_archived: thread.is_archived ?? false,
  }
}

export function normalizeWorkspaceSummary(
  value: WorkspaceSummary | unknown,
): WorkspaceSummary {
  const workspace = (value ?? {}) as Partial<WorkspaceSummary>
  const agents =
    workspace.agents?.map((agent) => normalizeWorkspaceAgent(agent, workspace)) ?? []

  return {
    id: workspace.id ?? '',
    path: workspace.path ?? '',
    status: workspace.status ?? 'disconnected',
    agents: agents.length > 0 ? agents : [fallbackWorkspaceAgent(workspace)],
    default_provider: normalizeProvider(workspace.default_provider),
    models: workspace.models ?? [],
    collaboration_modes: workspace.collaboration_modes ?? [],
    supports_plan_mode: workspace.supports_plan_mode ?? true,
    supports_native_plan_mode: workspace.supports_native_plan_mode ?? true,
    account: normalizeAccount(workspace.account),
    current_thread_id: workspace.current_thread_id ?? null,
    connected_at: workspace.connected_at ?? new Date(0).toISOString(),
    updated_at: workspace.updated_at ?? workspace.connected_at ?? new Date(0).toISOString(),
    last_error: workspace.last_error ?? null,
  }
}

export function normalizeThreadDetail(value: ThreadDetail | unknown): ThreadDetail {
  const detail = (value ?? {}) as Partial<ThreadDetail>
  return {
    workspace: normalizeWorkspaceSummary(detail.workspace),
    thread: normalizeThreadSummary(detail.thread),
    items: detail.items ?? [],
  }
}

export function normalizeThreadHandle(value: ThreadHandle | unknown): ThreadHandle {
  const handle = (value ?? {}) as Partial<ThreadHandle>
  return {
    workspace: normalizeWorkspaceSummary(handle.workspace),
    thread: normalizeThreadSummary(handle.thread),
  }
}

export function normalizeDaemonSnapshot(value: DaemonSnapshot | unknown): DaemonSnapshot {
  const snapshot = (value ?? {}) as Partial<DaemonSnapshot>
  return {
    daemon: snapshot.daemon ?? {
      version: 'unknown',
      started_at: new Date(0).toISOString(),
    },
    workspaces: (snapshot.workspaces ?? []).map((workspace) =>
      normalizeWorkspaceSummary(workspace),
    ),
    threads: (snapshot.threads ?? []).map((thread) => normalizeThreadSummary(thread)),
    interactive_requests: snapshot.interactive_requests ?? [],
  }
}

export function normalizeEventEnvelope(value: EventEnvelope | unknown): EventEnvelope {
  const envelope = (value ?? {}) as Partial<EventEnvelope>
  const event = envelope.event

  if (event?.type === 'snapshot') {
    return {
      ...(envelope as EventEnvelope),
      event: {
        ...event,
        snapshot: normalizeDaemonSnapshot(event.snapshot),
      },
    }
  }

  if (event?.type === 'thread-started' || event?.type === 'thread-updated') {
    return {
      ...(envelope as EventEnvelope),
      event: {
        ...event,
        thread: normalizeThreadSummary(event.thread),
      },
    }
  }

  return envelope as EventEnvelope
}
