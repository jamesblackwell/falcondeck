import type { AgentProvider, CollaborationModeSummary, ModelSummary } from '@falcondeck/client-core'

import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } from '@falcondeck/ui'

function formatModelLabel(label: string): string {
  return label.replace(/\b(gpt|codex|spark|claude)\b/gi, (match) => match.toUpperCase())
}

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
}: {
  value: string | null
  models: ModelSummary[]
  onValueChange: (value: string) => void
}) {
  return (
    <Select value={value ?? undefined} onValueChange={onValueChange}>
      <SelectTrigger>
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
}: {
  value: string | null
  options: string[]
  onValueChange: (value: string) => void
}) {
  return (
    <Select value={value ?? undefined} onValueChange={onValueChange}>
      <SelectTrigger>
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

export function CollaborationModeSelector({
  value,
  modes,
  onValueChange,
}: {
  value: string | null
  modes: CollaborationModeSummary[]
  onValueChange: (value: string) => void
}) {
  return (
    <Select value={value ?? undefined} onValueChange={onValueChange}>
      <SelectTrigger>
        <SelectValue placeholder="Mode" />
      </SelectTrigger>
      <SelectContent>
        {modes.map((mode) => (
          <SelectItem key={mode.id} value={mode.id}>
            {mode.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
