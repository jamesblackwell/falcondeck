import { useCallback, useEffect, useRef, useState } from 'react'
import { ScrollView } from 'react-native'

import { normalizePreferences, type UpdateNotificationPreferences } from '@falcondeck/client-core'

import { PreferenceSwitch, SettingsSection, settingsPageStyles } from '@/components/settings'
import { Text } from '@/components/ui'
import { clearPushToken, isPushEnabled, registerPushToken, setPushEnabled } from '@/lib/push-notifications'
import { useRelayStore, useSessionStore } from '@/store'

export default function NotificationSettingsScreen() {
  const preferences = normalizePreferences(useSessionStore((state) => state.snapshot?.preferences))
  const setPreferences = useSessionStore((state) => state.setPreferences)
  const current = preferences.notifications
  const [masterEnabled, setMasterEnabled] = useState(current.enabled && isPushEnabled())
  const [isUpdating, setIsUpdating] = useState(false)
  const updatingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(
    () => setMasterEnabled(current.enabled && isPushEnabled()),
    [current.enabled],
  )

  const update = useCallback(async (notifications: UpdateNotificationPreferences) => {
    if (updatingRef.current) return
    updatingRef.current = true
    setIsUpdating(true)
    setError(null)
    try {
      const relay = useRelayStore.getState()
      const updated = await relay._callRpc('preferences.update', { notifications })
      const normalized = normalizePreferences(updated)
      setPreferences(normalized)
      if (notifications.enabled !== undefined) {
        const enabled = normalized.notifications.enabled
        setMasterEnabled(enabled)
        setPushEnabled(enabled)
        const clientToken = relay._getClientToken()
        if (relay.sessionId && relay.deviceId && clientToken && relay.isEncrypted) {
          if (enabled) {
            void registerPushToken(relay.relayUrl, relay.sessionId, relay.deviceId, clientToken)
          } else {
            void clearPushToken(relay.relayUrl, relay.sessionId, relay.deviceId, clientToken)
          }
        }
      }
    } catch (reason) {
      setMasterEnabled(current.enabled && isPushEnabled())
      setError(reason instanceof Error ? reason.message : 'Failed to update notifications')
    } finally {
      updatingRef.current = false
      setIsUpdating(false)
    }
  }, [current.enabled, setPreferences])

  return (
    <ScrollView
      style={settingsPageStyles.container}
      contentContainerStyle={settingsPageStyles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      {error ? <Text variant="caption" color="danger" style={settingsPageStyles.error}>{error}</Text> : null}
      <SettingsSection footer="Your phone's system settings must allow notifications from FalconDeck as well.">
        <PreferenceSwitch
          label="Push notifications"
          description="Let agents get your attention on this phone."
          value={masterEnabled}
          disabled={isUpdating}
          onValueChange={(value) => {
            setMasterEnabled(value)
            void update({ enabled: value })
          }}
        />
      </SettingsSection>

      <SettingsSection
        title="Notify me about"
        footer="Stored on your desktop, so these apply to every device you pair."
      >
        <PreferenceSwitch
          label="Completed turns"
          value={current.notify_on_turn_complete}
          disabled={isUpdating || !masterEnabled}
          onValueChange={(value) => void update({ notify_on_turn_complete: value })}
        />
        <PreferenceSwitch
          label="Approvals and questions"
          value={current.notify_on_input_required}
          disabled={isUpdating || !masterEnabled}
          onValueChange={(value) => void update({ notify_on_input_required: value })}
        />
        <PreferenceSwitch
          label="Failed turns"
          value={current.notify_on_error}
          disabled={isUpdating || !masterEnabled}
          onValueChange={(value) => void update({ notify_on_error: value })}
        />
      </SettingsSection>

      <SettingsSection title="Delivery">
        <PreferenceSwitch
          label="Suppress while desktop is active"
          description="Avoid a phone alert while the paired desktop window is focused."
          value={current.suppress_when_desktop_active}
          disabled={isUpdating || !masterEnabled}
          onValueChange={(value) => void update({ suppress_when_desktop_active: value })}
        />
      </SettingsSection>
    </ScrollView>
  )
}
