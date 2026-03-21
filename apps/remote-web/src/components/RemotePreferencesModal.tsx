import type { FalconDeckPreferences, UpdatePreferencesPayload } from '@falcondeck/client-core'
import { normalizePreferences } from '@falcondeck/client-core'
import { Badge, Button } from '@falcondeck/ui'

import { X } from 'lucide-react'

const TOOL_DETAIL_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'expanded', label: 'Expanded' },
  { value: 'compact', label: 'Compact' },
  { value: 'hide_read_only_details', label: 'Hide read-only details' },
] as const

const PREFERENCE_TOGGLE_CONFIG = [
  {
    key: 'group_read_only_tools' as const,
    label: 'Group read-only tool bursts',
  },
  {
    key: 'show_expand_all_controls' as const,
    label: 'Show expand/collapse all controls',
  },
] as const

type RemotePreferencesModalProps = {
  isOpen: boolean
  preferences: FalconDeckPreferences | null
  onClose: () => void
  onUpdatePreferences: (payload: UpdatePreferencesPayload) => void
}

export function RemotePreferencesModal({
  isOpen,
  preferences,
  onClose,
  onUpdatePreferences,
}: RemotePreferencesModalProps) {
  if (!isOpen) {
    return null
  }

  const currentPreferences = normalizePreferences(preferences)
  const preferenceToggles = PREFERENCE_TOGGLE_CONFIG.map((toggle) => ({
    ...toggle,
    enabled: currentPreferences.conversation[toggle.key],
  }))

  return (
    <div className="fixed inset-0 z-50 bg-surface-0/80 backdrop-blur-sm">
      <button
        type="button"
        className="absolute inset-0 h-full w-full"
        aria-label="Close preferences"
        onClick={onClose}
      />
      <div className="absolute inset-x-4 top-20 mx-auto w-full max-w-xl rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[length:var(--fd-text-xs)] uppercase tracking-[0.24em] text-fg-muted">
              Preferences
            </p>
            <h2 className="mt-1 text-[length:var(--fd-text-lg)] font-semibold text-fg-primary">
              Conversation density
            </h2>
            <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-tertiary">
              These settings are stored in FalconDeck&apos;s shared `falcondeck.json`.
            </p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {TOOL_DETAIL_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() =>
                onUpdatePreferences({
                  conversation: { tool_details_mode: option.value },
                })
              }
              className={`rounded-[var(--fd-radius-lg)] border p-3 text-left transition-colors ${
                currentPreferences.conversation.tool_details_mode === option.value
                  ? 'border-accent/50 bg-accent/10'
                  : 'border-border-subtle bg-surface-2 hover:bg-surface-3'
              }`}
            >
              <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                {option.label}
              </p>
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-2">
          {preferenceToggles.map((toggle) => (
            <button
              key={toggle.key}
              type="button"
              onClick={() =>
                onUpdatePreferences({
                  conversation: {
                    [toggle.key]: !toggle.enabled,
                  } as UpdatePreferencesPayload['conversation'],
                })
              }
              className="flex w-full items-center justify-between rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 px-4 py-3 text-left"
            >
              <span className="text-[length:var(--fd-text-sm)] text-fg-primary">{toggle.label}</span>
              <Badge variant={toggle.enabled ? 'success' : 'default'} dot>
                {toggle.enabled ? 'On' : 'Off'}
              </Badge>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
