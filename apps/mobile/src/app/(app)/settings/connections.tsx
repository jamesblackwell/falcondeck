import { useState } from 'react'
import { Alert, ScrollView } from 'react-native'
import { useRouter } from 'expo-router'
import { isDaemonRpcReady } from '@falcondeck/client-core'

import { SettingsRow, SettingsSection, settingsPageStyles } from '@/components/settings'
import { useRelayStore } from '@/store'

function connectionSummary(
  status: string,
  encrypted: boolean,
  desktopOnline: boolean,
  daemonRpcReady: boolean,
  daemonPresenceKnown: boolean,
) {
  if (status === 'encrypted' && encrypted) {
    if (!daemonPresenceKnown) return 'Checking your Mac…'
    if (!desktopOnline) return 'Your Mac is offline'
    return daemonRpcReady ? 'Connected' : 'Repairing sync…'
  }
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
  const daemonPresenceKnown = presence !== null
  const daemonRpcReady = isDaemonRpcReady(presence)

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
      'This removes the saved connection and cached conversations on this phone. You will need a new pairing code from your desktop.',
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
      <SettingsSection
        title="Active connection"
        footer="Everything between this phone and your desktop is end-to-end encrypted. The relay passes it along without being able to read it."
      >
        <SettingsRow
          label="Status"
          value={connectionSummary(
            status,
            encrypted,
            desktopOnline,
            daemonRpcReady,
            daemonPresenceKnown,
          )}
        />
        <SettingsRow label="Encryption" value={encrypted ? 'End-to-end encrypted' : 'Not established'} />
        <SettingsRow
          label="Data sync"
          value={
            !daemonPresenceKnown
              ? 'Checking your Mac…'
              : !desktopOnline
                ? 'Your Mac is offline'
                : daemonRpcReady
                  ? 'Ready'
                  : 'Reconnecting…'
          }
        />
        <SettingsRow label="Relay" value={relayUrl} copyable />
        <SettingsRow label="Session" value={sessionId ?? '—'} copyable={Boolean(sessionId)} />
        <SettingsRow label="Device" value={deviceId ?? '—'} copyable={Boolean(deviceId)} />
      </SettingsSection>

      <SettingsSection
        title="Pair a different desktop"
        footer="This phone connects to one desktop at a time. Scan or enter a pairing code from FalconDeck on the desktop you want to use."
      >
        <SettingsRow
          label="Replace connection"
          value={isDisconnecting ? 'Disconnecting…' : undefined}
          destructive
          onPress={confirmReplace}
          accessibilityHint="Disconnects this phone and starts pairing again"
        />
      </SettingsSection>
    </ScrollView>
  )
}
