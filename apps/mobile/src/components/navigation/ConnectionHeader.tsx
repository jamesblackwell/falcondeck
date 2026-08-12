import { memo } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

import type { MachinePresence } from '@falcondeck/client-core'

interface ConnectionHeaderProps {
  connectionStatus: string
  isEncrypted: boolean
  machinePresence: MachinePresence | null
  onPress?: () => void
}

function connectionLabel(status: string): string {
  if (status === 'encrypted') return 'Connected'
  if (status === 'connected') return 'Securing session...'
  if (status === 'connecting') return 'Connecting...'
  if (status === 'disconnected') return 'Disconnected'
  if (status === 'claiming') return 'Pairing...'
  return 'Not connected'
}

function connectionState(
  connectionStatus: string,
  isEncrypted: boolean,
  desktopOnline: boolean,
): { connected: boolean; label: string } {
  const relayReady = connectionStatus === 'encrypted' && isEncrypted

  if (relayReady) {
    if (desktopOnline) return { connected: true, label: 'Connected' }
    return { connected: false, label: 'Desktop offline' }
  }

  return {
    connected: false,
    label: connectionLabel(connectionStatus),
  }
}

export const ConnectionHeader = memo(function ConnectionHeader({
  connectionStatus,
  isEncrypted,
  machinePresence,
  onPress,
}: ConnectionHeaderProps) {
  const desktopOnline = machinePresence?.daemon_connected ?? false
  const state = connectionState(connectionStatus, isEncrypted, desktopOnline)

  return (
    <Pressable
      style={styles.container}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Connection: ${state.label}`}
      accessibilityHint="Opens settings"
      hitSlop={8}
    >
      <View style={[styles.dot, state.connected ? styles.connected : styles.disconnected]} />
    </Pressable>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    minWidth: theme.minTouchTarget,
    minHeight: theme.minTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: theme.radius.full,
  },
  connected: { backgroundColor: theme.colors.success.default },
  disconnected: { backgroundColor: theme.colors.danger.default },
}))
