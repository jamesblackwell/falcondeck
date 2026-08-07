import { defaultProviderLabel } from './normalization'
import type {
  AgentCapabilitySummary,
  AgentProvider,
  ThreadSummary,
  WorkspaceAgentSummary,
  WorkspaceSummary,
} from './types'

/** Provider id used when a workspace names none. */
const FALLBACK_PROVIDER: AgentProvider = 'codex'

/** Capability set assumed for a provider the workspace does not describe. */
export const NO_AGENT_CAPABILITIES: AgentCapabilitySummary = {
  supports_review: false,
  supports_goals: false,
  supports_images: false,
  supports_skills: false,
  supports_interrupt: false,
  sandbox_modes: [],
  permission_modes: [],
}

/** Provider options shown before any workspace has been selected. */
const FALLBACK_PROVIDER_OPTIONS: ProviderOption[] = [
  { provider: 'codex', label: 'Codex' },
  { provider: 'claude', label: 'Claude' },
]

export type ProviderOption = {
  provider: AgentProvider
  label: string
}

export function defaultProvider(workspace: WorkspaceSummary | null | undefined): AgentProvider {
  const declared = workspace?.default_provider ?? workspace?.agents[0]?.provider
  return declared && declared.length > 0 ? declared : FALLBACK_PROVIDER
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

/**
 * Capabilities of one provider in a workspace. Unknown providers report nothing
 * so callers gate their controls off rather than guessing.
 */
export function workspaceAgentCapabilities(
  workspace: WorkspaceSummary | null | undefined,
  provider: AgentProvider,
): AgentCapabilitySummary {
  return workspaceAgent(workspace, provider)?.capabilities ?? NO_AGENT_CAPABILITIES
}

/** Providers the workspace offers, for the composer's provider picker. */
export function workspaceProviderOptions(
  workspace: WorkspaceSummary | null | undefined,
): ProviderOption[] {
  const agents = workspace?.agents ?? []
  if (agents.length === 0) return FALLBACK_PROVIDER_OPTIONS
  return agents.map((agent) => ({
    provider: agent.provider,
    label: agent.label || defaultProviderLabel(agent.provider),
  }))
}

/** Display name for a provider in this workspace, falling back to its id. */
export function workspaceProviderLabel(
  workspace: WorkspaceSummary | null | undefined,
  provider: AgentProvider,
): string {
  return workspaceAgent(workspace, provider)?.label || defaultProviderLabel(provider)
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
