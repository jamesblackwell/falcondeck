import { useState } from 'react'
import { View, ScrollView, Pressable, Switch } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'

import { clearPushToken, isPushEnabled, registerPushToken, setPushEnabled } from '@/lib/push-notifications'
import { useRelayStore } from '@/store'
import {
  FONT_SCALE_OPTIONS,
  PALETTE_OPTIONS,
  THEME_MODE_OPTIONS,
  useAppearanceStore,
} from '@/theme/appearance'
import { Text, Button, Card, CardContent } from '@/components/ui'

function connectionSummary(
  connectionStatus: string,
  isEncrypted: boolean,
  desktopOnline: boolean,
  hasSession: boolean,
) {
  if (connectionStatus === 'encrypted' && isEncrypted) {
    return desktopOnline ? 'Connected' : 'Desktop offline'
  }
  if (connectionStatus === 'connected') return 'Securing session...'
  if (connectionStatus === 'connecting') return hasSession ? 'Connecting...' : 'Not connected'
  if (connectionStatus === 'disconnected') return hasSession ? 'Waiting to reconnect' : 'Disconnected'
  if (connectionStatus === 'claiming') return 'Pairing...'
  return 'Not connected'
}

function encryptionSummary(connectionStatus: string, isEncrypted: boolean, hasSession: boolean) {
  if (connectionStatus === 'encrypted' && isEncrypted) return 'Relay session encrypted'
  if (connectionStatus === 'connected') return 'Establishing encrypted session'
  if (hasSession) return 'Waiting for encrypted relay session'
  return 'Not established'
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { theme } = useUnistyles()

  const relayUrl = useRelayStore((s) => s.relayUrl)
  const sessionId = useRelayStore((s) => s.sessionId)
  const isEncrypted = useRelayStore((s) => s.isEncrypted)
  const connectionStatus = useRelayStore((s) => s.connectionStatus)
  const machinePresence = useRelayStore((s) => s.machinePresence)
  const { disconnect } = useRelayStore.getState()
  const desktopOnline = machinePresence?.daemon_connected ?? false
  const statusLabel = connectionSummary(connectionStatus, isEncrypted, desktopOnline, !!sessionId)
  const encryptionLabel = encryptionSummary(connectionStatus, isEncrypted, !!sessionId)
  const statusColor = isEncrypted && desktopOnline ? 'success' : sessionId ? 'warning' : 'muted'
  const encryptionColor = isEncrypted ? 'success' : 'muted'

  const handleDisconnect = async () => {
    await disconnect()
    router.replace('/(auth)/pair')
  }

  const [pushEnabled, setPushEnabledState] = useState(isPushEnabled)

  const themeMode = useAppearanceStore((s) => s.themeMode)
  const palette = useAppearanceStore((s) => s.palette)
  const fontScale = useAppearanceStore((s) => s.fontScale)
  const setThemeMode = useAppearanceStore((s) => s.setThemeMode)
  const setPalette = useAppearanceStore((s) => s.setPalette)
  const setFontScale = useAppearanceStore((s) => s.setFontScale)

  const handlePushToggle = (enabled: boolean) => {
    setPushEnabledState(enabled)
    setPushEnabled(enabled)

    // Sync the relay registration right away when the session is usable.
    // Both calls are fire-and-forget safe and never throw.
    const relay = useRelayStore.getState()
    const clientToken = relay._getClientToken()
    if (!relay.sessionId || !relay.deviceId || !clientToken) return

    if (enabled) {
      if (relay.isEncrypted) {
        void registerPushToken(relay.relayUrl, relay.sessionId, relay.deviceId, clientToken)
      }
    } else {
      // Clears the relay-side token and the local last-registration marker so
      // a later re-enable re-registers from scratch.
      void clearPushToken(relay.relayUrl, relay.sessionId, relay.deviceId, clientToken)
    }
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
    >
      <View style={styles.titleRow}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <ChevronLeft size={24} color={theme.colors.fg.primary} />
        </Pressable>
        <Text variant="heading">
          Settings
        </Text>
      </View>

      <Card variant="flat" style={styles.card}>
        <CardContent>
          <View style={styles.row}>
            <Text variant="label" color="muted">Relay</Text>
            <Text variant="body" color="secondary" numberOfLines={1} style={styles.value}>
              {relayUrl}
            </Text>
          </View>
          <View style={styles.row}>
            <Text variant="label" color="muted">Session</Text>
            <Text variant="mono" color="tertiary" size="xs" numberOfLines={1} style={styles.value}>
              {sessionId ?? '—'}
            </Text>
          </View>
          <View style={styles.row}>
            <Text variant="label" color="muted">Status</Text>
            <Text variant="body" color={statusColor}>
              {statusLabel}
            </Text>
          </View>
          <View style={styles.row}>
            <Text variant="label" color="muted">Encryption</Text>
            <Text variant="body" color={encryptionColor}>
              {encryptionLabel}
            </Text>
          </View>
        </CardContent>
      </Card>

      <Card variant="flat" style={styles.card}>
        <CardContent>
          <View style={styles.settingBlock}>
            <Text variant="label" color="muted">Theme</Text>
            <View style={styles.segmentRow}>
              {THEME_MODE_OPTIONS.map((option) => {
                const selected = themeMode === option.value
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => setThemeMode(option.value)}
                    style={[styles.segment, selected && styles.segmentSelected]}
                  >
                    <Text
                      variant="label"
                      color={selected ? 'accent' : 'secondary'}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          </View>
          <View style={styles.settingBlock}>
            <Text variant="label" color="muted">Color theme</Text>
            <View style={styles.segmentRow}>
              {PALETTE_OPTIONS.map((option) => {
                const selected = palette === option.value
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => setPalette(option.value)}
                    style={[styles.segment, selected && styles.segmentSelected]}
                  >
                    <Text
                      variant="label"
                      color={selected ? 'accent' : 'secondary'}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          </View>
          <View style={styles.settingBlock}>
            <Text variant="label" color="muted">Text size</Text>
            <View style={styles.segmentRow}>
              {FONT_SCALE_OPTIONS.map((option) => {
                const selected = fontScale === option.value
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => setFontScale(option.value)}
                    style={[styles.segment, selected && styles.segmentSelected]}
                  >
                    <Text
                      variant="label"
                      color={selected ? 'accent' : 'secondary'}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          </View>
          <Text variant="caption" color="muted" style={styles.rowCaption}>
            System follows this device’s light or dark appearance.
          </Text>
        </CardContent>
      </Card>

      <Card variant="flat" style={styles.card}>
        <CardContent>
          <View style={styles.row}>
            <Text variant="label" color="muted">Push notifications</Text>
            <Switch
              value={pushEnabled}
              onValueChange={handlePushToggle}
              trackColor={{ false: theme.colors.surface[3], true: theme.colors.accent.default }}
              thumbColor={theme.colors.white}
            />
          </View>
          <Text variant="caption" color="muted" style={styles.rowCaption}>
            Get alerted when an agent needs attention while you are away.
          </Text>
        </CardContent>
      </Card>

      <View style={styles.disconnect}>
        <Button
          variant="danger"
          label="Disconnect"
          onPress={() => void handleDisconnect()}
        />
      </View>

      <Text variant="caption" color="faint" style={styles.version}>
        FalconDeck Mobile v0.1.0
      </Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface[0],
  },
  content: {
    padding: theme.spacing[4],
    gap: theme.spacing[4],
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
  },
  card: {
    gap: 0,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.subtle,
  },
  value: {
    flex: 1,
    textAlign: 'right',
    marginLeft: theme.spacing[4],
  },
  rowCaption: {
    paddingVertical: theme.spacing[2],
  },
  settingBlock: {
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  segmentRow: {
    flexDirection: 'row',
    gap: theme.spacing[2],
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: theme.spacing[2],
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    backgroundColor: theme.colors.surface[2],
  },
  segmentSelected: {
    borderColor: theme.colors.accent.default,
    backgroundColor: theme.colors.accent.muted,
  },
  disconnect: {
    marginTop: theme.spacing[4],
  },
  version: {
    textAlign: 'center',
    marginTop: theme.spacing[8],
  },
}))
