import { useState } from 'react'
import { Alert, ScrollView, View } from 'react-native'
import { useRouter } from 'expo-router'
import { StyleSheet } from 'react-native-unistyles'

import { SettingsRow, SettingsSection, settingsPageStyles } from '@/components/settings'
import { Button, Text } from '@/components/ui'
import { useRelayStore } from '@/store'

function connectionSummary(status: string, encrypted: boolean, desktopOnline: boolean) {
  if (status === 'encrypted' && encrypted) return desktopOnline ? 'Connected' : 'Daemon offline'
  if (status === 'connected') return 'Securing session…'
  if (status === 'connecting') return 'Connecting…'
  if (status === 'disconnected') return 'Waiting to reconnect'
  if (status === 'claiming') return 'Pairing…'
  return 'Not connected'
}

export default function ConnectionsSettingsScreen() {
  const router = useRouter()
  const relayUrl = useRelayStore((state) => state.relayUrl)
  const sessionId = useRelayStore((state) => state.sessionId)
  const deviceId = useRelayStore((state) => state.deviceId)
  const status = useRelayStore((state) => state.connectionStatus)
  const encrypted = useRelayStore((state) => state.isEncrypted)
  const presence = useRelayStore((state) => state.machinePresence)
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const desktopOnline = presence?.daemon_connected ?? false

  const disconnectAndPair = async () => {
    if (isDisconnecting) return
    setIsDisconnecting(true)
    try {
      await useRelayStore.getState().disconnect()
      router.replace('/(auth)/pair')
    } finally {
      setIsDisconnecting(false)
    }
  }

  const confirmReplace = () => {
    Alert.alert(
      'Replace connection?',
      'This phone currently stores one active FalconDeck connection. Replacing it removes the saved credentials and cached threads for this daemon.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Replace', style: 'destructive', onPress: () => void disconnectAndPair() },
      ],
    )
  }

  return (
    <ScrollView
      style={settingsPageStyles.container}
      contentContainerStyle={settingsPageStyles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <SettingsSection title="Active connection" footer="FalconDeck connects through the relay with end-to-end encryption; the relay cannot read daemon traffic.">
        <SettingsRow label="Status" value={connectionSummary(status, encrypted, desktopOnline)} />
        <SettingsRow label="Relay" value={relayUrl} />
        <SettingsRow label="Encryption" value={encrypted ? 'End-to-end encrypted' : 'Not established'} />
        <SettingsRow label="Session" value={sessionId ?? '—'} />
        <SettingsRow label="Device" value={deviceId ?? '—'} />
      </SettingsSection>

      <SettingsSection title="Pair another daemon" footer="Scan or enter a pairing code created by FalconDeck Desktop or an already-installed server daemon. SSH provisioning and server installation remain desktop-only.">
        <View style={styles.action}>
          <Button
            variant="secondary"
            label="Replace Connection"
            loading={isDisconnecting}
            disabled={isDisconnecting}
            onPress={confirmReplace}
          />
        </View>
      </SettingsSection>

      <Text variant="caption" color="faint">
        Simultaneous connections to several daemons require host-scoped encrypted storage and session routing. This screen deliberately manages the single active mobile connection until that transport work lands.
      </Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create((theme) => ({
  action: { padding: theme.spacing[4] },
}))
