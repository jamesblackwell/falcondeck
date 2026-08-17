import { ScrollView } from 'react-native'
import { useRouter, type Href } from 'expo-router'
import { Bell, Info, MessageSquareText, Mic, MonitorCog, Palette } from 'lucide-react-native'
import { useUnistyles } from 'react-native-unistyles'

import { normalizePreferences } from '@falcondeck/client-core'

import { SettingsRow, SettingsSection, settingsPageStyles } from '@/components/settings'
import { useRelayStore, useSessionStore } from '@/store'
import { useAppearanceStore } from '@/theme/appearance'

function connectionLabel(
  status: string,
  encrypted: boolean,
  desktopOnline: boolean,
  daemonRpcReady: boolean,
  daemonPresenceKnown: boolean,
) {
  if (status === 'encrypted' && encrypted) {
    if (!daemonPresenceKnown) return 'Checking…'
    if (!desktopOnline) return 'Offline'
    return daemonRpcReady ? 'Connected' : 'Repairing'
  }
  if (status === 'connected') return 'Securing…'
  if (status === 'connecting') return 'Connecting…'
  if (status === 'disconnected') return 'Reconnecting…'
  return 'Not connected'
}

export default function SettingsScreen() {
  const router = useRouter()
  const { theme } = useUnistyles()
  const connectionStatus = useRelayStore((state) => state.connectionStatus)
  const isEncrypted = useRelayStore((state) => state.isEncrypted)
  const machinePresence = useRelayStore((state) => state.machinePresence)
  const preferences = useSessionStore((state) => state.snapshot?.preferences)
  const themeMode = useAppearanceStore((state) => state.themeMode)
  const normalized = normalizePreferences(preferences)
  const desktopOnline = machinePresence?.daemon_connected ?? false
  const daemonPresenceKnown = machinePresence !== null
  const daemonRpcReady = machinePresence?.daemon_rpc_ready ?? desktopOnline
  const appearanceValue = themeMode === 'system'
    ? 'System'
    : themeMode === 'light' ? 'Light' : 'Dark'
  const notificationValue = normalized.notifications.enabled ? 'On' : 'Off'

  return (
    <ScrollView
      style={settingsPageStyles.container}
      contentContainerStyle={settingsPageStyles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <SettingsSection>
        <SettingsRow
          label="Connections"
          detail="Pairing, relay status, and encryption"
          value={connectionLabel(
            connectionStatus,
            isEncrypted,
            desktopOnline,
            daemonRpcReady,
            daemonPresenceKnown,
          )}
          icon={<MonitorCog size={theme.iconSize.sm} color={theme.colors.info.default} />}
          onPress={() => router.push('/(app)/settings/connections')}
        />
      </SettingsSection>

      <SettingsSection title="Preferences">
        <SettingsRow
          label="Appearance"
          detail="Light and dark themes, and text size"
          value={appearanceValue}
          icon={<Palette size={theme.iconSize.sm} color={theme.colors.accent.default} />}
          onPress={() => router.push('/(app)/settings/appearance')}
        />
        <SettingsRow
          label="Conversation"
          detail="Tool activity, thinking, and expansion rules"
          icon={<MessageSquareText size={theme.iconSize.sm} color={theme.colors.warning.default} />}
          onPress={() => router.push('/(app)/settings/conversation')}
        />
        <SettingsRow
          label="Notifications"
          detail="Choose which agent events alert this phone"
          value={notificationValue}
          icon={<Bell size={theme.iconSize.sm} color={theme.colors.danger.default} />}
          onPress={() => router.push('/(app)/settings/notifications')}
        />
        <SettingsRow
          label="Speech"
          detail="On-device or OpenRouter transcription"
          icon={<Mic size={theme.iconSize.sm} color={theme.colors.info.default} />}
          onPress={() => router.push('/(app)/settings/speech' as Href)}
        />
      </SettingsSection>

      <SettingsSection>
        <SettingsRow
          label="About FalconDeck"
          detail="Version and mobile connection model"
          icon={<Info size={theme.iconSize.sm} color={theme.colors.fg.muted} />}
          onPress={() => router.push('/(app)/settings/about')}
        />
      </SettingsSection>
    </ScrollView>
  )
}
