import { View, ScrollView, Pressable } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'

import { useRelayStore } from '@/store'
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

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
    >
      <View style={styles.titleRow}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <ChevronLeft size={24} color={theme.colors.fg.primary} />
        </Pressable>
        <Text variant="heading" size="2xl" weight="bold">
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
  disconnect: {
    marginTop: theme.spacing[4],
  },
  version: {
    textAlign: 'center',
    marginTop: theme.spacing[8],
  },
}))
