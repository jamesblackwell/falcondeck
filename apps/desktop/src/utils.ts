import type { ThreadSummary, WorkspaceSummary } from '@falcondeck/client-core'

export function defaultModelId(workspace: WorkspaceSummary | null) {
  return workspace?.models.find((model) => model.is_default)?.id ?? workspace?.models[0]?.id ?? null
}

export function resolveThreadModelId(
  thread: ThreadSummary | null,
  workspace: WorkspaceSummary | null,
  preferredModelId?: string | null,
) {
  return preferredModelId ?? thread?.codex.model_id ?? defaultModelId(workspace)
}

export function reasoningOptions(
  thread: ThreadSummary | null,
  workspace: WorkspaceSummary | null,
  preferredModelId?: string | null,
) {
  const model = workspace?.models.find(
    (entry) => entry.id === resolveThreadModelId(thread, workspace, preferredModelId),
  )
  const options = model?.supported_reasoning_efforts.map((entry) => entry.reasoning_effort) ?? []
  if (options.length > 0) return options
  return model?.default_reasoning_effort ? [model.default_reasoning_effort] : ['medium']
}

