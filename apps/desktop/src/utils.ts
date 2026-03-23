import {
  defaultProvider,
  workspaceModels,
  type AgentProvider,
  type ThreadSummary,
  type WorkspaceSummary,
} from '@falcondeck/client-core'

export function defaultModelId(
  workspace: WorkspaceSummary | null,
  provider?: AgentProvider | null,
) {
  const activeProvider = provider ?? defaultProvider(workspace)
  const models = workspaceModels(workspace, activeProvider)
  return models.find((model) => model.is_default)?.id ?? models[0]?.id ?? null
}

export function resolveThreadModelId(
  thread: ThreadSummary | null,
  workspace: WorkspaceSummary | null,
  preferredModelId?: string | null,
  provider?: AgentProvider | null,
) {
  const activeProvider = thread?.provider ?? provider ?? defaultProvider(workspace)
  const models = workspaceModels(workspace, activeProvider)
  if (preferredModelId && models.some((model) => model.id === preferredModelId)) {
    return preferredModelId
  }
  if (thread?.agent.model_id && models.some((model) => model.id === thread.agent.model_id)) {
    return thread.agent.model_id
  }
  return (
    defaultModelId(workspace, activeProvider)
  )
}

export function reasoningOptions(
  thread: ThreadSummary | null,
  workspace: WorkspaceSummary | null,
  preferredModelId?: string | null,
  provider?: AgentProvider | null,
) {
  const activeProvider = thread?.provider ?? provider ?? defaultProvider(workspace)
  const model = workspaceModels(workspace, activeProvider).find(
    (entry) => entry.id === resolveThreadModelId(thread, workspace, preferredModelId, activeProvider),
  )
  const options = model?.supported_reasoning_efforts.map((entry) => entry.reasoning_effort) ?? []
  if (options.length > 0) return options
  return model?.default_reasoning_effort ? [model.default_reasoning_effort] : ['medium']
}

export function defaultReasoningEffort(
  thread: ThreadSummary | null,
  workspace: WorkspaceSummary | null,
  preferredModelId?: string | null,
  provider?: AgentProvider | null,
) {
  const activeProvider = thread?.provider ?? provider ?? defaultProvider(workspace)
  const model = workspaceModels(workspace, activeProvider).find(
    (entry) => entry.id === resolveThreadModelId(thread, workspace, preferredModelId, activeProvider),
  )
  return (
    model?.default_reasoning_effort ??
    model?.supported_reasoning_efforts[0]?.reasoning_effort ??
    'medium'
  )
}

export function resolveReasoningEffort(
  thread: ThreadSummary | null,
  workspace: WorkspaceSummary | null,
  preferredModelId?: string | null,
  preferredEffort?: string | null,
  provider?: AgentProvider | null,
) {
  const options = reasoningOptions(thread, workspace, preferredModelId, provider)
  if (preferredEffort && options.includes(preferredEffort)) {
    return preferredEffort
  }
  if (thread?.agent.reasoning_effort && options.includes(thread.agent.reasoning_effort)) {
    return thread.agent.reasoning_effort
  }
  return defaultReasoningEffort(thread, workspace, preferredModelId, provider)
}
