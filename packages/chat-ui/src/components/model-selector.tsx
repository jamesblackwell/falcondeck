import { useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, Zap } from 'lucide-react'

import {
  formatModelLabel,
  type AgentProvider,
  type ModelSummary,
  type ProviderOption,
  type ServiceTierOption,
} from '@falcondeck/client-core'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } from '@falcondeck/ui'

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

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * The single model chip on the composer: model, reasoning effort, and the fast
 * service tier live in one popover so the toggle row stays short. The trigger
 * reads like ChatGPT's — "GPT-5.6-Sol · Medium" with a filled bolt while the
 * fast tier is on.
 */
export function ModelMenu({
  models,
  selectedModel,
  onModelChange,
  reasoningOptions,
  selectedEffort,
  onEffortChange,
  fastTier = null,
  fastActive = false,
  onFastActiveChange,
  showFastRow = false,
  disabled = false,
}: {
  models: ModelSummary[]
  /** The model a send would use: the explicit pick or the provider default. */
  selectedModel: ModelSummary | null
  onModelChange: (value: string) => void
  reasoningOptions: string[]
  selectedEffort: string | null
  onEffortChange: (value: string) => void
  /** Fast tier of the selected model; null greys the row out. */
  fastTier?: ServiceTierOption | null
  fastActive?: boolean
  onFastActiveChange?: (active: boolean) => void
  /** True when any model of the provider advertises a tier, so the row does not flicker per model. */
  showFastRow?: boolean
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const isFastOn = fastActive && fastTier !== null
  const triggerLabel = selectedModel ? formatModelLabel(selectedModel.label) : 'Model'
  const effortLabel = selectedEffort && reasoningOptions.length > 0 ? capitalize(selectedEffort) : null

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Model"
          disabled={disabled || models.length === 0}
          className="fd-focus inline-flex h-7 max-w-full items-center gap-1 rounded-[var(--fd-radius-md)] px-1.5 text-[length:var(--fd-text-xs)] text-fg-muted transition-colors duration-[var(--fd-duration-fast)] hover:bg-surface-3 hover:text-fg-secondary disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-surface-3 data-[state=open]:text-fg-secondary"
        >
          {isFastOn ? (
            <Zap aria-hidden="true" className="h-3 w-3 shrink-0 text-accent" fill="currentColor" />
          ) : null}
          <span className="truncate">{triggerLabel}</span>
          {effortLabel ? <span className="shrink-0 text-fg-muted">{effortLabel}</span> : null}
          <ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0 text-fg-muted" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 w-64 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1 shadow-[var(--fd-shadow-lg)]"
        >
          <p className="px-2.5 pb-1 pt-1.5 text-[length:var(--fd-text-2xs)] font-medium uppercase tracking-[0.08em] text-fg-muted">
            Model
          </p>
          <div className="max-h-56 overflow-y-auto">
            {models.map((model) => {
              const isSelected = model.id === selectedModel?.id
              return (
                <button
                  key={model.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isSelected}
                  onClick={() => {
                    onModelChange(model.id)
                    setOpen(false)
                  }}
                  className="flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-left text-[length:var(--fd-text-sm)] text-fg-primary transition-colors hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 truncate">{formatModelLabel(model.label)}</span>
                  {isSelected ? <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> : null}
                </button>
              )
            })}
          </div>

          {reasoningOptions.length > 0 ? (
            <>
              <p className="border-t border-border-subtle px-2.5 pb-1 pt-2 text-[length:var(--fd-text-2xs)] font-medium uppercase tracking-[0.08em] text-fg-muted">
                Reasoning effort
              </p>
              <div
                role="radiogroup"
                aria-label="Reasoning effort"
                className="flex items-center gap-1 px-1.5 pb-1.5"
              >
                {reasoningOptions.map((option) => {
                  const isSelected = option === selectedEffort
                  return (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => onEffortChange(option)}
                      className={cn(
                        'fd-focus h-6 flex-1 rounded-[var(--fd-radius-md)] text-[length:var(--fd-text-xs)] transition-colors',
                        isSelected
                          ? 'bg-surface-3 text-fg-primary'
                          : 'text-fg-muted hover:bg-surface-2 hover:text-fg-secondary',
                      )}
                    >
                      {capitalize(option)}
                    </button>
                  )
                })}
              </div>
            </>
          ) : null}

          {showFastRow && onFastActiveChange ? (
            <div className="border-t border-border-subtle pt-1">
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={isFastOn}
                aria-label="Fast mode"
                disabled={fastTier === null}
                title={
                  fastTier === null
                    ? 'This model has one speed'
                    : fastTier.description || `Run on the ${fastTier.name} tier`
                }
                onClick={() => onFastActiveChange(!isFastOn)}
                className="flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-left text-[length:var(--fd-text-sm)] text-fg-primary transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {/* The bolt fills in when the tier is on, so state survives without color. */}
                <Zap
                  aria-hidden="true"
                  className={cn('h-3.5 w-3.5 shrink-0', isFastOn ? 'text-accent' : 'text-fg-muted')}
                  fill={isFastOn ? 'currentColor' : 'none'}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{fastTier?.name ?? 'Fast'} mode</span>
                  {fastTier?.description ? (
                    <span className="block truncate text-[length:var(--fd-text-xs)] text-fg-muted">
                      {fastTier.description}
                    </span>
                  ) : null}
                </span>
                {isFastOn ? <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> : null}
              </button>
            </div>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
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
