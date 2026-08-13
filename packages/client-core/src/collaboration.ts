import { defaultProviderLabel } from "./normalization";
import type {
  AgentCapabilitySummary,
  AgentProvider,
  ModelSummary,
  ServiceTierOption,
  ThreadSummary,
  WorkspaceAgentSummary,
  WorkspaceSummary,
} from "./types";

/** Provider id used when a workspace names none. */
const FALLBACK_PROVIDER: AgentProvider = "codex";

/** Capability set assumed for a provider the workspace does not describe. */
export const NO_AGENT_CAPABILITIES: AgentCapabilitySummary = {
  supports_review: false,
  supports_goals: false,
  supports_images: false,
  supports_skills: false,
  supports_interrupt: false,
  supports_steering: false,
  supports_forking: false,
  sandbox_modes: [],
  permission_modes: [],
};

/** Provider options shown before any workspace has been selected. */
const FALLBACK_PROVIDER_OPTIONS: ProviderOption[] = [
  { provider: "codex", label: "Codex" },
  { provider: "claude", label: "Claude" },
];

export type ProviderOption = {
  provider: AgentProvider;
  label: string;
};

export function defaultProvider(
  workspace: WorkspaceSummary | null | undefined,
): AgentProvider {
  const declared =
    workspace?.default_provider ?? workspace?.agents[0]?.provider;
  return declared && declared.length > 0 ? declared : FALLBACK_PROVIDER;
}

export function providerForThread(
  thread: ThreadSummary | null | undefined,
  workspace: WorkspaceSummary | null | undefined,
): AgentProvider {
  return thread?.provider ?? defaultProvider(workspace);
}

export function workspaceAgent(
  workspace: WorkspaceSummary | null | undefined,
  provider: AgentProvider,
): WorkspaceAgentSummary | null {
  return workspace?.agents.find((entry) => entry.provider === provider) ?? null;
}

/**
 * Capabilities of one provider in a workspace. Unknown providers report nothing
 * so callers gate their controls off rather than guessing.
 */
export function workspaceAgentCapabilities(
  workspace: WorkspaceSummary | null | undefined,
  provider: AgentProvider,
): AgentCapabilitySummary {
  return (
    workspaceAgent(workspace, provider)?.capabilities ?? NO_AGENT_CAPABILITIES
  );
}

/** Capabilities that depend on the transport pinned to an existing thread. */
export function threadAgentCapabilities(
  workspace: WorkspaceSummary | null | undefined,
  provider: AgentProvider,
  thread: ThreadSummary | null | undefined,
): AgentCapabilitySummary {
  const capabilities = workspaceAgentCapabilities(workspace, provider);
  if (provider !== "opencode" || thread?.provider !== "opencode") {
    return capabilities;
  }
  return {
    ...capabilities,
    supports_steering: thread.provider_transport === "native",
  };
}

/**
 * Prevents a composer from silently degrading images for a provider that
 * explicitly does not accept image content. The attachments remain available
 * so the user can remove them or switch providers without losing work.
 */
export function imageAttachmentSendBlockReason(
  capabilities: AgentCapabilitySummary,
  attachmentCount: number,
): string | null {
  if (attachmentCount <= 0 || capabilities.supports_images) return null;
  return `The selected agent does not support image attachments. Remove ${
    attachmentCount === 1 ? "the image" : "the images"
  } or choose an agent that supports images.`;
}

/** Providers the workspace offers, for the composer's provider picker. */
export function workspaceProviderOptions(
  workspace: WorkspaceSummary | null | undefined,
): ProviderOption[] {
  const agents = workspace?.agents ?? [];
  if (agents.length === 0) return FALLBACK_PROVIDER_OPTIONS;
  return agents.map((agent) => ({
    provider: agent.provider,
    label: agent.label || defaultProviderLabel(agent.provider),
  }));
}

/** Display name for a provider in this workspace, falling back to its id. */
export function workspaceProviderLabel(
  workspace: WorkspaceSummary | null | undefined,
  provider: AgentProvider,
): string {
  return (
    workspaceAgent(workspace, provider)?.label || defaultProviderLabel(provider)
  );
}

export function workspaceModels(
  workspace: WorkspaceSummary | null | undefined,
  provider: AgentProvider,
) {
  return workspaceAgent(workspace, provider)?.models ?? workspace?.models ?? [];
}

/** Native collaboration modes advertised by one provider. */
export function workspaceCollaborationModes(
  workspace: WorkspaceSummary | null | undefined,
  provider: AgentProvider,
) {
  return workspaceAgent(workspace, provider)?.collaboration_modes ?? [];
}

/** Converts the normalized permission choice into the provider wire field. */
export function approvalPolicyForProvider(
  provider: AgentProvider,
  permissionMode: string | null | undefined,
): string {
  if (provider === "codex") {
    if (permissionMode === "default") return "on-request";
    if (permissionMode) return permissionMode;
    return "never";
  }
  return "on-request";
}

export function formatModelLabel(label: string) {
  return label.toLowerCase();
}

/**
 * Wire value that explicitly resets a provider to its standard service tier.
 * Sending it (rather than omitting the field) matters because an absent tier
 * means "keep whatever the session already has" all the way down to the CLI.
 */
export const STANDARD_SERVICE_TIER = "default";

/**
 * The tier the fast-mode toggle switches a model onto: its first advertised
 * extra service tier (Codex advertises exactly one, `priority`/"Fast").
 */
export function modelFastTier(
  model: ModelSummary | null | undefined,
): ServiceTierOption | null {
  return model?.service_tiers?.[0] ?? null;
}

/** Whether any of the models can run on an extra service tier. */
export function anyModelHasFastTier(models: ModelSummary[]): boolean {
  return models.some((model) => modelFastTier(model) !== null);
}

/**
 * Validates a remembered/thread tier id against what the model actually
 * advertises, so the toggle never resurrects a tier the catalog dropped.
 * The standard tier normalizes to null (toggle off).
 */
export function resolveServiceTier(
  tier: string | null | undefined,
  model: ModelSummary | null | undefined,
): string | null {
  if (!tier || tier === STANDARD_SERVICE_TIER) return null;
  return model?.service_tiers?.some((option) => option.id === tier)
    ? tier
    : null;
}

/**
 * The service tier a turn should request for a model, stated explicitly when
 * the model supports tiers (see STANDARD_SERVICE_TIER for why), and omitted
 * entirely for models without tiers so their providers never see the field.
 */
export function serviceTierForTurn(
  selectedTier: string | null,
  model: ModelSummary | null | undefined,
): string | null {
  if (modelFastTier(model) === null) return null;
  return resolveServiceTier(selectedTier, model) ?? STANDARD_SERVICE_TIER;
}

export function workspaceAccount(
  workspace: WorkspaceSummary | null | undefined,
  provider: AgentProvider,
) {
  return (
    workspaceAgent(workspace, provider)?.account ?? workspace?.account ?? null
  );
}
