import {
  defaultProvider,
  providerForThread,
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
) {
  return (
    preferredModelId ??
    thread?.agent.model_id ??
    defaultModelId(workspace, providerForThread(thread, workspace))
  )
}

export function reasoningOptions(
  thread: ThreadSummary | null,
  workspace: WorkspaceSummary | null,
  preferredModelId?: string | null,
) {
  const provider = providerForThread(thread, workspace)
  const model = workspaceModels(workspace, provider).find(
    (entry) => entry.id === resolveThreadModelId(thread, workspace, preferredModelId),
  )
  const options = model?.supported_reasoning_efforts.map((entry) => entry.reasoning_effort) ?? []
  if (options.length > 0) return options
  return model?.default_reasoning_effort ? [model.default_reasoning_effort] : ['medium']
}

export function defaultReasoningEffort(
  thread: ThreadSummary | null,
  workspace: WorkspaceSummary | null,
  preferredModelId?: string | null,
) {
  const provider = providerForThread(thread, workspace)
  const model = workspaceModels(workspace, provider).find(
    (entry) => entry.id === resolveThreadModelId(thread, workspace, preferredModelId),
  )
  return (
    model?.default_reasoning_effort ??
    model?.supported_reasoning_efforts[0]?.reasoning_effort ??
    'medium'
  )
}
