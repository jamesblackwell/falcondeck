import type {
  AgentProvider,
  CollaborationModeSummary,
  ThreadSummary,
  WorkspaceAgentSummary,
  WorkspaceSummary,
} from './types'

export const PLAN_MODE_ID = 'plan'

export function defaultProvider(workspace: WorkspaceSummary | null | undefined): AgentProvider {
  return workspace?.default_provider ?? workspace?.agents[0]?.provider ?? 'codex'
}

export function providerForThread(
  thread: ThreadSummary | null | undefined,
  workspace: WorkspaceSummary | null | undefined,
): AgentProvider {
  return thread?.provider ?? defaultProvider(workspace)
}

export function workspaceAgent(
  workspace: WorkspaceSummary | null | undefined,
  provider: AgentProvider,
): WorkspaceAgentSummary | null {
  return workspace?.agents.find((entry) => entry.provider === provider) ?? null
}

export function workspaceModels(
  workspace: WorkspaceSummary | null | undefined,
  provider: AgentProvider,
) {
  return workspaceAgent(workspace, provider)?.models ?? workspace?.models ?? []
}

export function workspaceCollaborationModes(
  workspace: WorkspaceSummary | null | undefined,
  provider: AgentProvider,
) {
  return (
    workspaceAgent(workspace, provider)?.collaboration_modes ??
    workspace?.collaboration_modes ??
    []
  )
}

export function workspaceAccount(
  workspace: WorkspaceSummary | null | undefined,
  provider: AgentProvider,
) {
  return workspaceAgent(workspace, provider)?.account ?? workspace?.account ?? null
}

function isPlanMode(mode: CollaborationModeSummary) {
  return (mode.mode ?? mode.id).toLowerCase() === PLAN_MODE_ID
}

function collaborationModesForPlanLookup(
  workspace:
    | Pick<WorkspaceSummary, 'collaboration_modes' | 'agents'>
    | Pick<WorkspaceAgentSummary, 'collaboration_modes'>
    | null
    | undefined,
  provider?: AgentProvider,
) {
  if (!workspace) return []
  if (!provider || !('agents' in workspace)) {
    return workspace.collaboration_modes
  }
  return (
    workspace.agents.find((entry) => entry.provider === provider)?.collaboration_modes ??
    workspace.collaboration_modes
  )
}

export function findPlanMode(
  workspace:
    | Pick<WorkspaceSummary, 'collaboration_modes' | 'agents'>
    | Pick<WorkspaceAgentSummary, 'collaboration_modes'>
    | null
    | undefined,
  provider?: AgentProvider,
): CollaborationModeSummary | null {
  return collaborationModesForPlanLookup(workspace, provider).find(isPlanMode) ?? null
}

export function supportsPlanMode(
  workspace: WorkspaceSummary | null | undefined,
  provider?: AgentProvider,
) {
  if (!workspace) return false
  const agent = provider ? workspaceAgent(workspace, provider) : null
  return agent?.supports_plan_mode ?? workspace.supports_plan_mode ?? Boolean(findPlanMode(workspace, provider))
}

export function supportsNativePlanMode(
  workspace: WorkspaceSummary | null | undefined,
  provider?: AgentProvider,
) {
  if (!workspace) return false
  const agent = provider ? workspaceAgent(workspace, provider) : null
  return (
    agent?.supports_native_plan_mode ??
    workspace.supports_native_plan_mode ??
    Boolean(findPlanMode(workspace, provider)?.is_native ?? true)
  )
}

export function planModeId(
  workspace: WorkspaceSummary | null | undefined,
  provider?: AgentProvider,
) {
  const mode = findPlanMode(workspace, provider)
  if (mode) return mode.id
  return supportsPlanMode(workspace, provider) ? PLAN_MODE_ID : null
}

export function isPlanModeEnabled(
  collaborationModeId: string | null | undefined,
  workspace: WorkspaceSummary | null | undefined,
  provider?: AgentProvider,
) {
  if (!collaborationModeId) return false
  const mode = workspaceCollaborationModes(
    workspace,
    provider ?? defaultProvider(workspace),
  ).find((entry) => entry.id === collaborationModeId)
  if (!mode) return collaborationModeId.toLowerCase() === PLAN_MODE_ID
  return isPlanMode(mode)
}

export function togglePlanMode(
  enabled: boolean,
  workspace: WorkspaceSummary | null | undefined,
  currentModeId: string | null | undefined,
  provider?: AgentProvider,
) {
  if (!enabled) return null
  return planModeId(workspace, provider) ?? currentModeId ?? PLAN_MODE_ID
}

export function defaultCollaborationModeId(
  thread: ThreadSummary | null | undefined,
) {
  return thread?.agent.collaboration_mode_id ?? null
}
