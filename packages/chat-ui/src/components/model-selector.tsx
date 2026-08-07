import {
  formatModelLabel,
  type AgentProvider,
  type ModelSummary,
  type ProviderOption,
} from '@falcondeck/client-core'

import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } from '@falcondeck/ui'

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
  if (providers.length === 0) {
    return null
  }

  return (
    <div className="inline-flex items-center rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1">
      {providers.map((option) => {
        const active = value === option.provider
        return (
          <Button
            key={option.provider}
            type="button"
            variant={active ? 'secondary' : 'ghost'}
            size="sm"
            disabled={disabled}
            onClick={() => onValueChange(option.provider)}
            className={cn('h-7 px-3', !active && 'text-fg-muted')}
            aria-pressed={active}
          >
            {option.label}
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
  if (modes.length === 0) {
    return null
  }

  // Providers that offer an explicit "default" mode use it as the null state;
  // the rest show the placeholder until a mode is picked.
  const hasDefaultMode = modes.includes('default')

  return (
    <Select
      value={value ?? (hasDefaultMode ? 'default' : undefined)}
      onValueChange={(next) => onValueChange(next === 'default' ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger disabled={disabled} aria-label="Permission mode">
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
  if (modes.length === 0) {
    return null
  }

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
