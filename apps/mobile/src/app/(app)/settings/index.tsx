import { View, ScrollView, Pressable } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'

import { useRelayStore } from '@/store'
import { Text, Button, Card, CardContent } from '@/components/ui'

export default function SettingsScreen() {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { theme } = useUnistyles()

  const relayUrl = useRelayStore((s) => s.relayUrl)
  const sessionId = useRelayStore((s) => s.sessionId)
  const isEncrypted = useRelayStore((s) => s.isEncrypted)
  const connectionStatus = useRelayStore((s) => s.connectionStatus)
  const { disconnect } = useRelayStore.getState()

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
            <Text variant="body" color={isEncrypted ? 'success' : 'warning'}>
              {connectionStatus}
            </Text>
          </View>
          <View style={styles.row}>
            <Text variant="label" color="muted">Encryption</Text>
            <Text variant="body" color={isEncrypted ? 'success' : 'muted'}>
              {isEncrypted ? 'E2E Active' : 'Not established'}
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
