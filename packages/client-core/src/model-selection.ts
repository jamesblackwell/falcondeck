import {
  type AgentProvider,
  type ThreadSummary,
  type WorkspaceSummary,
  type ModelSummary,
} from './types'
import { defaultProvider, workspaceModels } from './collaboration'

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
  // Existing threads own their settings, including a provider-default model.
  if (thread) return thread.agent.model_id
  if (preferredModelId && models.some((model) => model.id === preferredModelId)) {
    return preferredModelId
  }
  return defaultModelId(workspace, activeProvider)
}

export function reasoningOptions(
  thread: ThreadSummary | null,
  workspace: WorkspaceSummary | null,
  preferredModelId?: string | null,
  provider?: AgentProvider | null,
) {
  const activeProvider = thread?.provider ?? provider ?? defaultProvider(workspace)
  const model = resolveModelOption(
    workspaceModels(workspace, activeProvider),
    preferredModelId ?? resolveThreadModelId(thread, workspace, null, activeProvider),
    activeProvider,
  )
  const options = model?.supported_reasoning_efforts.map((entry) => entry.reasoning_effort) ?? []
  if (options.length > 0) return options
  if (model?.default_reasoning_effort) return [model.default_reasoning_effort]
  return model || thread ? [] : ['medium']
}

export function defaultReasoningEffort(
  thread: ThreadSummary | null,
  workspace: WorkspaceSummary | null,
  preferredModelId?: string | null,
  provider?: AgentProvider | null,
) {
  const activeProvider = thread?.provider ?? provider ?? defaultProvider(workspace)
  const model = resolveModelOption(
    workspaceModels(workspace, activeProvider),
    resolveThreadModelId(thread, workspace, preferredModelId, activeProvider),
    activeProvider,
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
  // Null means the provider decides; never replace it with composer preferences
  // or the first advertised effort (which is commonly low).
  if (thread) return thread.agent.reasoning_effort
  const options = reasoningOptions(thread, workspace, preferredModelId, provider)
  if (preferredEffort && options.includes(preferredEffort)) {
    return preferredEffort
  }
  return defaultReasoningEffort(thread, workspace, preferredModelId, provider)
}

/** Resolve display metadata without changing the model ID sent to the provider. */
export function resolveModelOption(
  models: ModelSummary[],
  modelId: string | null | undefined,
  provider: AgentProvider,
): ModelSummary | null {
  if (!modelId) return models.find((model) => model.is_default) ?? models[0] ?? null
  const exact = models.find((model) => model.id === modelId)
  const claude = provider === 'claude'
    ? /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)(?:-\d{8})?$/.exec(modelId)
    : null
  if (exact && (!claude || exact.label !== modelId)) return exact
  const alias = claude ? models.find((model) => model.id === claude[1]) : null
  const label = claude
    ? `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}`
    : modelId
  // A pinned version can differ from today's alias (e.g. Haiku 5.5 vs 4.5).
  // Keep its version in the label rather than relabelling it as the latest alias.
  if (exact) return { ...exact, label }
  if (alias) return { ...alias, label }
  return {
    id: modelId, label, is_default: false,
    default_reasoning_effort: null, supported_reasoning_efforts: [],
  }
}

/** Follow recorded model/effort changes without resetting draft picks on mode updates. */
export function threadComposerSelectionKey(workspaceId: string, thread: ThreadSummary | null) {
  return JSON.stringify([
    workspaceId, thread?.id ?? null, thread?.provider ?? null,
    thread?.agent.model_id ?? null, thread?.agent.reasoning_effort ?? null,
  ])
}
