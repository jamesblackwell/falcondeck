import { useEffect, useId, useRef, useState } from 'react'

import type { FalconDeckPreferences, UpdatePreferencesPayload } from '@falcondeck/client-core'
import { normalizePreferences } from '@falcondeck/client-core'
import { AppearanceControls, Badge, Button } from '@falcondeck/ui'

import { X } from 'lucide-react'

import type { NotificationPreference } from '../lib/remoteAppUtils'

const TOOL_DETAIL_OPTIONS = [
  { value: 'collapsed', label: 'Hidden' },
  { value: 'auto', label: 'Auto' },
  { value: 'expanded', label: 'Expanded' },
  { value: 'compact', label: 'Compact' },
  { value: 'hide_read_only_details', label: 'Hide read-only details' },
] as const

// Mirrors THINKING_DISPLAY_OPTIONS in apps/desktop's settings-utils; the two
// clients write the same shared falcondeck.json field.
const THINKING_DISPLAY_OPTIONS = [
  {
    value: 'auto',
    label: 'Auto',
    description: 'Expand a thought while it streams, then collapse it when it ends.',
  },
  {
    value: 'preview',
    label: 'Preview',
    description: 'Keep a few faded lines visible; tap to read the rest.',
  },
  {
    value: 'always_expanded',
    label: 'Always expanded',
    description: 'Show reasoning in full.',
  },
  {
    value: 'always_collapsed',
    label: 'Always collapsed',
    description: 'Keep every thought behind its own line.',
  },
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
  notificationPreference: NotificationPreference
  onClose: () => void
  onUpdatePreferences: (payload: UpdatePreferencesPayload) => void
  onNotificationPreferenceChange: (value: NotificationPreference) => void
}

export function RemotePreferencesModal(props: RemotePreferencesModalProps) {
  if (!props.isOpen) {
    return null
  }
  return <RemotePreferencesDialog {...props} />
}

function RemotePreferencesDialog({
  preferences,
  notificationPreference,
  onClose,
  onUpdatePreferences,
  onNotificationPreferenceChange,
}: RemotePreferencesModalProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const [notificationNotice, setNotificationNotice] = useState<string | null>(null)

  const currentPreferences = normalizePreferences(preferences)
  const preferenceToggles = PREFERENCE_TOGGLE_CONFIG.map((toggle) => ({
    ...toggle,
    enabled: currentPreferences.conversation[toggle.key],
  }))

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    closeButtonRef.current?.focus()

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      // Without this the tab order walks straight out of the dialog and into
      // the transcript behind it, which is still rendered.
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      opener?.focus?.()
    }
  }, [onClose])

  // Permission has to be asked for inside the click that turns this on:
  // Safari and Firefox reject requestPermission() outside a user gesture.
  async function handleToggleNotifications() {
    if (notificationPreference === 'enabled') {
      onNotificationPreferenceChange('disabled')
      setNotificationNotice(null)
      return
    }
    if (typeof Notification === 'undefined') {
      setNotificationNotice('This browser does not support notifications.')
      return
    }
    if (Notification.permission === 'denied') {
      setNotificationNotice(
        'Your browser is blocking notifications for this site. Allow them in the site settings, then try again.',
      )
      return
    }
    if (Notification.permission !== 'granted') {
      const result = await Notification.requestPermission().catch(() => 'denied' as const)
      if (result !== 'granted') {
        setNotificationNotice('Notification permission was not granted.')
        return
      }
    }
    setNotificationNotice(null)
    onNotificationPreferenceChange('enabled')
  }

  return (
    <div className="fixed inset-0 z-50 bg-[var(--fd-overlay-strong)] backdrop-blur-sm">
      <button
        type="button"
        className="absolute inset-0 h-full w-full"
        aria-label="Close preferences"
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute inset-x-4 top-[calc(env(safe-area-inset-top)+2.5rem)] mx-auto max-h-[calc(100dvh-env(safe-area-inset-top)-5rem)] w-full max-w-xl overflow-y-auto rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[length:var(--fd-text-xs)] uppercase tracking-[0.24em] text-fg-muted">
              Preferences
            </p>
            <h2
              id={titleId}
              className="mt-1 text-[length:var(--fd-text-lg)] font-semibold text-fg-primary"
            >
              Appearance
            </h2>
            <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-tertiary">
              Theme, fonts, and text size are stored on this device.
            </p>
          </div>
          <Button
            ref={closeButtonRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close preferences"
            onClick={onClose}
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-4">
          <AppearanceControls />
        </div>

        <div className="mt-6 border-t border-border-subtle pt-5">
          <h2 className="text-[length:var(--fd-text-lg)] font-semibold text-fg-primary">
            Notifications
          </h2>
          <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-tertiary">
            Alert this browser when a thread needs you. Stored on this device.
          </p>
        </div>

        <div className="mt-4 space-y-2">
          <button
            type="button"
            aria-pressed={notificationPreference === 'enabled'}
            onClick={() => void handleToggleNotifications()}
            className="fd-focus flex w-full items-center justify-between rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 px-4 py-3 text-left transition-colors hover:bg-surface-3"
          >
            <span className="text-[length:var(--fd-text-sm)] text-fg-primary">
              Notify me about thread activity
            </span>
            <Badge variant={notificationPreference === 'enabled' ? 'success' : 'default'} dot>
              {notificationPreference === 'enabled' ? 'On' : 'Off'}
            </Badge>
          </button>
          {notificationNotice ? (
            <p role="status" className="text-[length:var(--fd-text-xs)] text-warning">
              {notificationNotice}
            </p>
          ) : null}
        </div>

        <div className="mt-6 border-t border-border-subtle pt-5">
          <h2 className="text-[length:var(--fd-text-lg)] font-semibold text-fg-primary">
            Conversation density
          </h2>
          <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-tertiary">
            These settings are stored in FalconDeck&apos;s shared `falcondeck.json`.
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label="Tool detail"
          className="mt-4 grid gap-3 md:grid-cols-2"
        >
          {TOOL_DETAIL_OPTIONS.map((option) => {
            const selected = currentPreferences.conversation.tool_details_mode === option.value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() =>
                  onUpdatePreferences({
                    conversation: { tool_details_mode: option.value },
                  })
                }
                className={`fd-focus rounded-[var(--fd-radius-lg)] border p-3 text-left transition-colors ${
                  selected
                    ? 'border-accent/50 bg-accent/10'
                    : 'border-border-subtle bg-surface-2 hover:bg-surface-3'
                }`}
              >
                <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                  {option.label}
                </p>
              </button>
            )
          })}
        </div>

        <div className="mt-6">
          <h3 className="text-[length:var(--fd-text-sm)] font-semibold text-fg-primary">
            Reasoning
          </h3>
          <div role="radiogroup" aria-label="Reasoning display" className="mt-3 space-y-2">
            {THINKING_DISPLAY_OPTIONS.map((option) => {
              const selected = currentPreferences.conversation.thinking_display === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() =>
                    onUpdatePreferences({
                      conversation: { thinking_display: option.value },
                    })
                  }
                  className={`fd-focus w-full rounded-[var(--fd-radius-lg)] border p-3 text-left transition-colors ${
                    selected
                      ? 'border-accent/50 bg-accent/10'
                      : 'border-border-subtle bg-surface-2 hover:bg-surface-3'
                  }`}
                >
                  <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                    {option.label}
                  </p>
                  <p className="mt-0.5 text-[length:var(--fd-text-xs)] text-fg-tertiary">
                    {option.description}
                  </p>
                </button>
              )
            })}
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {preferenceToggles.map((toggle) => (
            <button
              key={toggle.key}
              type="button"
              aria-pressed={toggle.enabled}
              onClick={() =>
                onUpdatePreferences({
                  conversation: {
                    [toggle.key]: !toggle.enabled,
                  } as UpdatePreferencesPayload['conversation'],
                })
              }
              className="fd-focus flex w-full items-center justify-between rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 px-4 py-3 text-left transition-colors hover:bg-surface-3"
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
