import type { CollaborationModeSummary, ThreadSummary, WorkspaceSummary } from './types'

export const PLAN_MODE_ID = 'plan'

function isPlanMode(mode: CollaborationModeSummary) {
  return (mode.mode ?? mode.id).toLowerCase() === PLAN_MODE_ID
}

export function findPlanMode(
  workspace: Pick<WorkspaceSummary, 'collaboration_modes'> | null | undefined,
): CollaborationModeSummary | null {
  return workspace?.collaboration_modes.find(isPlanMode) ?? null
}

export function supportsPlanMode(workspace: WorkspaceSummary | null | undefined) {
  if (!workspace) return false
  return workspace.supports_plan_mode ?? Boolean(findPlanMode(workspace))
}

export function supportsNativePlanMode(workspace: WorkspaceSummary | null | undefined) {
  if (!workspace) return false
  return workspace.supports_native_plan_mode ?? Boolean(findPlanMode(workspace)?.is_native ?? true)
}

export function planModeId(workspace: WorkspaceSummary | null | undefined) {
  const mode = findPlanMode(workspace)
  if (mode) return mode.id
  return supportsPlanMode(workspace) ? PLAN_MODE_ID : null
}

export function isPlanModeEnabled(
  collaborationModeId: string | null | undefined,
  workspace: WorkspaceSummary | null | undefined,
) {
  if (!collaborationModeId) return false
  const mode = workspace?.collaboration_modes.find((entry) => entry.id === collaborationModeId)
  if (!mode) return collaborationModeId.toLowerCase() === PLAN_MODE_ID
  return isPlanMode(mode)
}

export function togglePlanMode(
  enabled: boolean,
  workspace: WorkspaceSummary | null | undefined,
  currentModeId: string | null | undefined,
) {
  if (!enabled) return null
  return planModeId(workspace) ?? currentModeId ?? PLAN_MODE_ID
}

export function defaultCollaborationModeId(
  thread: ThreadSummary | null | undefined,
) {
  return thread?.codex.collaboration_mode_id ?? null
}
