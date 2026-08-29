import type {
  AgentControlSettings,
  Automation,
  AutomationConcurrencyPolicy,
  AutomationMisfirePolicy,
} from '@falcondeck/client-core'

export type AutomationScheduleKind = 'cron' | 'interval' | 'once'
export type AutomationThreadKind = 'managed' | 'existing' | 'new_each_run'

export type AutomationDraft = {
  name: string
  description: string
  scheduleKind: AutomationScheduleKind
  expression: string
  timezone: string
  everySeconds: string
  runAt: string
  instruction: string
  conditional: boolean
  noActionMarker: string
  workspacePath: string
  provider: string
  threadKind: AutomationThreadKind
  threadId: string
  modelId: string
  permissionMode: string
  sandboxMode: string
  requiredConnectors: string
  selectedSkills: string
  concurrencyPolicy: AutomationConcurrencyPolicy
  misfirePolicy: AutomationMisfirePolicy
  anchorAt: string
}

export function emptyAutomationDraft(
  settings: AgentControlSettings | null,
  workspacePath = '',
): AutomationDraft {
  return {
    name: '',
    description: '',
    scheduleKind: 'cron',
    expression: '0 8 * * 1-5',
    timezone: settings?.default_timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    everySeconds: '3600',
    runAt: '',
    instruction: '',
    conditional: false,
    noActionMarker: 'FALCONDECK_NO_ACTION',
    workspacePath,
    provider: 'codex',
    threadKind: 'managed',
    threadId: '',
    modelId: '',
    permissionMode: '',
    sandboxMode: '',
    requiredConnectors: '',
    selectedSkills: '',
    concurrencyPolicy: 'skip',
    misfirePolicy: 'skip',
    anchorAt: '',
  }
}

export function automationDraftFromDefinition(automation: Automation): AutomationDraft {
  // Drafts are built from single-automation reads, which always carry the
  // task and thread; list rows omit them, so fall back to editor defaults.
  const task = automation.task ?? { kind: 'prompt' as const, instruction: '' }
  const thread = automation.target.thread ?? { kind: 'managed' as const }
  return {
    name: automation.name,
    description: automation.description ?? '',
    scheduleKind: automation.trigger.kind,
    expression: automation.trigger.kind === 'cron' ? automation.trigger.expression : '',
    timezone: automation.trigger.kind === 'cron' ? automation.trigger.timezone : '',
    everySeconds:
      automation.trigger.kind === 'interval' ? String(automation.trigger.every_seconds) : '3600',
    runAt: automation.trigger.kind === 'once' ? automation.trigger.run_at : '',
    instruction: task.instruction,
    conditional: task.kind === 'conditional_prompt',
    noActionMarker: task.kind === 'conditional_prompt' ? task.no_action_marker : '',
    workspacePath: automation.target.workspace_path,
    provider: automation.target.provider,
    threadKind: thread.kind,
    threadId: thread.kind === 'managed' || thread.kind === 'existing' ? thread.thread_id ?? '' : '',
    modelId: automation.target.model_id ?? '',
    permissionMode: automation.target.permission_mode ?? '',
    sandboxMode: automation.target.sandbox_mode ?? '',
    requiredConnectors: automation.required_connectors.join(', '),
    selectedSkills: (automation.target.selected_skills ?? []).join(', '),
    concurrencyPolicy: automation.concurrency_policy,
    misfirePolicy: automation.misfire_policy,
    anchorAt: automation.trigger.kind === 'interval' ? automation.trigger.anchor_at : '',
  }
}

function commaSeparated(value: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

export function automationDraftArguments(draft: AutomationDraft): Record<string, unknown> {
  const trigger = draft.scheduleKind === 'cron'
    ? { kind: 'cron', expression: draft.expression.trim(), timezone: draft.timezone.trim() }
    : draft.scheduleKind === 'interval'
      ? {
          kind: 'interval',
          every_seconds: Number(draft.everySeconds) || 0,
          // The persisted anchor is part of the schedule. Re-anchoring an edit
          // to the time it was saved would silently move every future run.
          anchor_at: draft.anchorAt.trim() || new Date().toISOString(),
        }
      : { kind: 'once', run_at: draft.runAt.trim() }

  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    trigger,
    task: draft.conditional
      ? {
          kind: 'conditional_prompt',
          instruction: draft.instruction,
          no_action_marker: draft.noActionMarker.trim(),
        }
      : { kind: 'prompt', instruction: draft.instruction },
    target: {
      workspace_path: draft.workspacePath.trim(),
      provider: draft.provider,
      thread: draft.threadKind === 'managed'
        ? {
            kind: 'managed',
            ...(draft.threadId.trim() ? { thread_id: draft.threadId.trim() } : {}),
          }
        : draft.threadKind === 'existing'
          ? { kind: 'existing', thread_id: draft.threadId.trim() }
          : { kind: 'new_each_run' },
      ...(draft.modelId.trim() ? { model_id: draft.modelId.trim() } : {}),
      ...(draft.permissionMode.trim() ? { permission_mode: draft.permissionMode.trim() } : {}),
      ...(draft.sandboxMode.trim() ? { sandbox_mode: draft.sandboxMode.trim() } : {}),
      selected_skills: commaSeparated(draft.selectedSkills),
    },
    required_connectors: commaSeparated(draft.requiredConnectors),
    concurrency_policy: draft.concurrencyPolicy,
    misfire_policy: draft.misfirePolicy,
  }
}

export function automationDraftError(draft: AutomationDraft): string | null {
  if (!draft.name.trim()) return 'A name is required.'
  if (!draft.instruction.trim()) return 'An instruction is required.'
  if (!draft.workspacePath.trim().startsWith('/')) return 'Workspace path must be absolute.'
  if (draft.scheduleKind === 'cron' && draft.expression.trim().split(/\s+/).length !== 5) {
    return 'Cron expressions use exactly five fields.'
  }
  if (draft.scheduleKind === 'cron' && !draft.timezone.trim()) return 'A timezone is required.'
  if (draft.scheduleKind === 'interval' && Number(draft.everySeconds) < 60) {
    return 'Intervals must be at least 60 seconds.'
  }
  if (draft.scheduleKind === 'once' && !draft.runAt.trim()) {
    return 'A one-time schedule needs an RFC 3339 timestamp with an offset.'
  }
  if (draft.threadKind === 'existing' && !draft.threadId.trim()) {
    return 'An existing thread id is required.'
  }
  if (draft.conditional && !draft.noActionMarker.trim()) {
    return 'Conditional automations need a no-action marker.'
  }
  return null
}

export function automationDraftIsElevated(draft: AutomationDraft) {
  return [draft.permissionMode.trim(), draft.sandboxMode.trim()].some((mode) =>
    mode === 'bypassPermissions' || mode === 'danger-full-access',
  )
}

export function automationScheduleSummary(automation: Automation) {
  if (automation.resolved_schedule) return automation.resolved_schedule
  const trigger = automation.trigger
  if (trigger.kind === 'cron') return `cron “${trigger.expression}” (${trigger.timezone})`
  if (trigger.kind === 'interval') {
    const minutes = trigger.every_seconds / 60
    return minutes >= 60 && minutes % 60 === 0
      ? `every ${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`
      : `every ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  }
  return `once at ${new Date(trigger.run_at).toLocaleString()}`
}
