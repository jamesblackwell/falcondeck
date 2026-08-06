import type {
  AgentProvider,
  ThreadSummary,
  WorkspaceAgentSummary,
  WorkspaceSummary,
} from './types'

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

export function formatModelLabel(label: string) {
  return label.toLowerCase()
}

export function workspaceAccount(
  workspace: WorkspaceSummary | null | undefined,
  provider: AgentProvider,
) {
  return workspaceAgent(workspace, provider)?.account ?? workspace?.account ?? null
}
