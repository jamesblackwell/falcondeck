import {
  formatModelLabel,
  type AgentProvider,
  type ModelSummary,
} from '@falcondeck/client-core'

import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } from '@falcondeck/ui'

export function ProviderSelector({
  value,
  onValueChange,
  disabled = false,
}: {
  value: AgentProvider
  onValueChange: (value: AgentProvider) => void
  disabled?: boolean
}) {
  return (
    <div className="inline-flex items-center rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1">
      {(['codex', 'claude'] as AgentProvider[]).map((provider) => {
        const active = value === provider
        return (
          <Button
            key={provider}
            type="button"
            variant={active ? 'secondary' : 'ghost'}
            size="sm"
            disabled={disabled}
            onClick={() => onValueChange(provider)}
            className={cn('h-7 px-3 capitalize', !active && 'text-fg-muted')}
            aria-pressed={active}
          >
            {provider}
          </Button>
        )
      })}
    </div>
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
    <Select value={value ?? undefined} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger disabled={disabled}>
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
    <Select value={value ?? undefined} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger disabled={disabled}>
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

const PERMISSION_MODES: { value: string; label: string }[] = [
  { value: 'default', label: 'Ask to approve' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'auto', label: 'Auto' },
  { value: 'dontAsk', label: "Don't ask" },
  { value: 'bypassPermissions', label: 'Bypass permissions' },
]

/** Claude permission mode picker; `null` value means the CLI default. */
export function PermissionModeSelector({
  value,
  onValueChange,
  disabled = false,
}: {
  value: string | null
  onValueChange: (value: string | null) => void
  disabled?: boolean
}) {
  return (
    <Select
      value={value ?? 'default'}
      onValueChange={(next) => onValueChange(next === 'default' ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger disabled={disabled} aria-label="Permission mode">
        <SelectValue placeholder="Permissions" />
      </SelectTrigger>
      <SelectContent>
        {PERMISSION_MODES.map((mode) => (
          <SelectItem key={mode.value} value={mode.value}>
            {mode.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

const SANDBOX_MODES: { value: string; label: string }[] = [
  { value: 'default', label: 'Default sandbox' },
  { value: 'read-only', label: 'Read only' },
  { value: 'workspace-write', label: 'Workspace write' },
  { value: 'danger-full-access', label: 'Full access' },
]

/** Codex sandbox mode picker; `null` value defers to the provider config. */
export function SandboxSelector({
  value,
  onValueChange,
  disabled = false,
}: {
  value: string | null
  onValueChange: (value: string | null) => void
  disabled?: boolean
}) {
  return (
    <Select
      value={value ?? 'default'}
      onValueChange={(next) => onValueChange(next === 'default' ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger disabled={disabled} aria-label="Sandbox mode">
        <SelectValue placeholder="Sandbox" />
      </SelectTrigger>
      <SelectContent>
        {SANDBOX_MODES.map((mode) => (
          <SelectItem key={mode.value} value={mode.value}>
            {mode.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
