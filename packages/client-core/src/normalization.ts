import type {
  AccountSummary,
  AgentProvider,
  ConversationPreferences,
  DaemonSnapshot,
  EventEnvelope,
  FalconDeckPreferences,
  ThreadHandle,
  ThreadAgentParams,
  ThreadDetail,
  ThreadSummary,
  ToolCallDisplay,
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

const DEFAULT_TOOL_CALL_DISPLAY: ToolCallDisplay = {
  is_read_only: false,
  has_side_effect: false,
  is_error: false,
  artifact_kind: 'none',
  summary_hint: null,
}

const DEFAULT_CONVERSATION_PREFERENCES: ConversationPreferences = {
  tool_details_mode: 'auto',
  auto_expand: {
    approvals: true,
    errors: true,
    first_diff: true,
    failed_tests: true,
  },
  group_read_only_tools: true,
  show_expand_all_controls: true,
}

const DEFAULT_PREFERENCES: FalconDeckPreferences = {
  version: 1,
  conversation: DEFAULT_CONVERSATION_PREFERENCES,
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
    items: (detail.items ?? []).map((item) =>
      item.kind === 'tool_call'
        ? {
            ...item,
            display: normalizeToolCallDisplay((item as { display?: unknown }).display),
          }
        : item,
    ),
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
    preferences: normalizePreferences(snapshot.preferences),
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

  if (event?.type === 'preferences-updated') {
    return {
      ...(envelope as EventEnvelope),
      event: {
        ...event,
        preferences: normalizePreferences(event.preferences),
      },
    }
  }

  return envelope as EventEnvelope
}

export function normalizeToolCallDisplay(value: unknown): ToolCallDisplay {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_TOOL_CALL_DISPLAY }
  }

  const display = value as Partial<ToolCallDisplay>
  const artifactKind =
    display.artifact_kind === 'diff' ||
    display.artifact_kind === 'test' ||
    display.artifact_kind === 'command_output' ||
    display.artifact_kind === 'approval_related'
      ? display.artifact_kind
      : 'none'

  return {
    is_read_only: display.is_read_only ?? false,
    has_side_effect: display.has_side_effect ?? false,
    is_error: display.is_error ?? false,
    artifact_kind: artifactKind,
    summary_hint:
      typeof display.summary_hint === 'string' && display.summary_hint.trim().length > 0
        ? display.summary_hint
        : null,
  }
}

export function normalizePreferences(value: unknown): FalconDeckPreferences {
  if (!value || typeof value !== 'object') {
    return {
      ...DEFAULT_PREFERENCES,
      conversation: {
        ...DEFAULT_CONVERSATION_PREFERENCES,
        auto_expand: { ...DEFAULT_CONVERSATION_PREFERENCES.auto_expand },
      },
    }
  }

  const raw = value as Partial<FalconDeckPreferences>
  const conversation = (raw.conversation ?? {}) as Partial<ConversationPreferences>
  const autoExpand = (conversation.auto_expand ?? {}) as Partial<
    ConversationPreferences['auto_expand']
  >

  const toolDetailsMode =
    conversation.tool_details_mode === 'expanded' ||
    conversation.tool_details_mode === 'compact' ||
    conversation.tool_details_mode === 'hide_read_only_details'
      ? conversation.tool_details_mode
      : 'auto'

  return {
    version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : 1,
    conversation: {
      tool_details_mode: toolDetailsMode,
      auto_expand: {
        approvals: autoExpand.approvals ?? true,
        errors: autoExpand.errors ?? true,
        first_diff: autoExpand.first_diff ?? true,
        failed_tests: autoExpand.failed_tests ?? true,
      },
      group_read_only_tools: conversation.group_read_only_tools ?? true,
      show_expand_all_controls: conversation.show_expand_all_controls ?? true,
    },
  }
}
