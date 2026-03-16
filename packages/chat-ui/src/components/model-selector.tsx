import type { CollaborationModeSummary, ModelSummary } from '@falcondeck/client-core'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@falcondeck/ui'

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
      <SelectTrigger className="h-10 min-w-[180px]">
        <SelectValue placeholder="Select model" />
      </SelectTrigger>
      <SelectContent>
        {models.map((model) => (
          <SelectItem key={model.id} value={model.id}>
            {model.label}
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
      <SelectTrigger className="h-10 min-w-[140px]">
        <SelectValue placeholder="Effort" />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
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
      <SelectTrigger className="h-10 min-w-[160px]">
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
