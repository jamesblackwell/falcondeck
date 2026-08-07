import {
  formatModelLabel,
  type AgentProvider,
  type ModelSummary,
  type ProviderOption,
  type ThreadIsolation,
} from '@falcondeck/client-core'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@falcondeck/ui'

export function ProviderSelector({
  value,
  providers,
  onValueChange,
  disabled = false,
}: {
  value: AgentProvider
  providers: ProviderOption[]
  onValueChange: (value: AgentProvider) => void
  disabled?: boolean
}) {
  // A dropdown rather than a segmented control: the provider roster keeps
  // growing (Codex, Claude, Grok, Gemini, OpenCode, …) and segments don't scale.
  // An empty roster greys the control rather than removing it, so the toggle
  // row keeps its shape while a workspace is still connecting.
  return (
    <Select
      value={value}
      onValueChange={(next) => onValueChange(next as AgentProvider)}
      disabled={disabled || providers.length === 0}
    >
      <SelectTrigger
        variant="quiet"
        disabled={disabled || providers.length === 0}
        aria-label="Agent"
      >
        <SelectValue placeholder="Agent" />
      </SelectTrigger>
      <SelectContent>
        {providers.map((option) => (
          <SelectItem key={option.provider} value={option.provider}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function ModelSelector({
  value,
  models,
  onValueChange,
  disabled = false,
}: {
  value: string | null
  models: ModelSummary[]
  onValueChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <Select value={value ?? ''} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger variant="quiet" disabled={disabled} aria-label="Model">
        <SelectValue placeholder="Model" />
      </SelectTrigger>
      <SelectContent>
        {models.map((model) => (
          <SelectItem key={model.id} value={model.id}>
            {formatModelLabel(model.label)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function ReasoningSelector({
  value,
  options,
  onValueChange,
  disabled = false,
}: {
  value: string | null
  options: string[]
  onValueChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <Select value={value ?? ''} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger variant="quiet" disabled={disabled} aria-label="Reasoning effort">
        <SelectValue placeholder="Effort" />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option.charAt(0).toUpperCase() + option.slice(1)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

const PERMISSION_MODE_LABELS: Record<string, string> = {
  default: 'Ask to approve',
  acceptEdits: 'Accept edits',
  auto: 'Auto',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
}

const SANDBOX_MODE_LABELS: Record<string, string> = {
  'read-only': 'Read only',
  'workspace-write': 'Workspace write',
  'danger-full-access': 'Full access',
}

/** Turns an unrecognised provider mode id into something readable. */
function humanizeModeId(mode: string) {
  const spaced = mode.replace(/[-_]+/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function modeLabel(labels: Record<string, string>, mode: string) {
  return labels[mode] ?? humanizeModeId(mode)
}

/**
 * Permission mode picker driven by the provider's advertised modes; `null`
 * means the provider's own default.
 */
export function PermissionModeSelector({
  value,
  modes,
  onValueChange,
  disabled = false,
}: {
  value: string | null
  modes: string[]
  onValueChange: (value: string | null) => void
  disabled?: boolean
}) {
  // Providers that offer an explicit "default" mode use it as the null state;
  // the rest show the placeholder until a mode is picked.
  const hasDefaultMode = modes.includes('default')
  // Greyed, not removed: our provider set is open, so hiding the control makes
  // the composer reflow every time the agent changes.
  const unavailable = modes.length === 0

  return (
    <Select
      // Always a string, never undefined: these pickers stay mounted while
      // their options load, and flipping between uncontrolled and controlled
      // makes React drop the selection.
      value={value ?? (hasDefaultMode ? 'default' : '')}
      onValueChange={(next) => onValueChange(next === 'default' ? null : next)}
      disabled={disabled || unavailable}
    >
      <SelectTrigger
        variant="quiet"
        disabled={disabled || unavailable}
        aria-label="Permission mode"
        title={unavailable ? 'This agent has no permission modes' : undefined}
      >
        <SelectValue placeholder="Permissions" />
      </SelectTrigger>
      <SelectContent>
        {modes.map((mode) => (
          <SelectItem key={mode} value={mode}>
            {modeLabel(PERMISSION_MODE_LABELS, mode)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * Sandbox mode picker driven by the provider's advertised modes; `null` defers
 * to the provider config.
 */
export function SandboxSelector({
  value,
  modes,
  onValueChange,
  disabled = false,
}: {
  value: string | null
  modes: string[]
  onValueChange: (value: string | null) => void
  disabled?: boolean
}) {
  const unavailable = modes.length === 0

  return (
    <Select
      value={value ?? 'default'}
      onValueChange={(next) => onValueChange(next === 'default' ? null : next)}
      disabled={disabled || unavailable}
    >
      <SelectTrigger
        variant="quiet"
        disabled={disabled || unavailable}
        aria-label="Sandbox mode"
        title={unavailable ? 'This agent has no sandbox modes' : undefined}
      >
        <SelectValue placeholder="Sandbox" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">Default sandbox</SelectItem>
        {modes
          .filter((mode) => mode !== 'default')
          .map((mode) => (
            <SelectItem key={mode} value={mode}>
              {modeLabel(SANDBOX_MODE_LABELS, mode)}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  )
}

/**
 * Where a new thread will run. Only meaningful before the thread exists —
 * isolation is fixed at creation, so the composer hides this once a thread is
 * selected rather than offering a control that would silently do nothing.
 */
export function IsolationSelector({
  value,
  onValueChange,
  disabled = false,
}: {
  value: ThreadIsolation
  onValueChange: (value: ThreadIsolation) => void
  disabled?: boolean
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onValueChange(next as ThreadIsolation)}
      disabled={disabled}
    >
      <SelectTrigger variant="quiet" disabled={disabled} aria-label="Run in">
        <SelectValue placeholder="Run in" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="project_folder">Project folder</SelectItem>
        <SelectItem value="isolated">Isolated copy</SelectItem>
      </SelectContent>
    </Select>
  )
}
