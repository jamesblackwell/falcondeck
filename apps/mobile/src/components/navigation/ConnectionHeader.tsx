import { memo } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

import { isDaemonRpcReady, type MachinePresence } from '@falcondeck/client-core'

import { CONNECTION_COPY } from '@/lib/connection-copy'

interface ConnectionHeaderProps {
  connectionStatus: string
  isEncrypted: boolean
  machinePresence: MachinePresence | null
  onPress?: () => void
}

export function connectionLabel(status: string): string {
  if (status === 'encrypted') return CONNECTION_COPY.connected
  if (status === 'connected') return CONNECTION_COPY.securing
  if (status === 'connecting') return CONNECTION_COPY.connecting
  if (status === 'disconnected') return CONNECTION_COPY.reconnecting
  if (status === 'claiming') return CONNECTION_COPY.pairingShort
  return CONNECTION_COPY.notConnected
}

export type ConnectionTone = 'connected' | 'repairing' | 'disconnected'

export function connectionState(
  connectionStatus: string,
  isEncrypted: boolean,
  desktopOnline: boolean,
  daemonRpcReady = desktopOnline,
  daemonPresenceKnown = true,
): { tone: ConnectionTone; label: string } {
  const relayReady = connectionStatus === 'encrypted' && isEncrypted

  if (relayReady) {
    if (!daemonPresenceKnown) return { tone: 'repairing', label: CONNECTION_COPY.checkingDesktop }
    if (!desktopOnline) return { tone: 'disconnected', label: CONNECTION_COPY.desktopOffline }
    if (!daemonRpcReady) return { tone: 'repairing', label: CONNECTION_COPY.repairing }
    return { tone: 'connected', label: CONNECTION_COPY.connected }
  }

  return {
    tone: 'disconnected',
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
  const daemonRpcReady = isDaemonRpcReady(machinePresence)
  const state = connectionState(
    connectionStatus,
    isEncrypted,
    desktopOnline,
    daemonRpcReady,
    machinePresence !== null,
  )

  return (
    <Pressable
      style={styles.container}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Connection: ${state.label}`}
      accessibilityHint="Shows what the connection is doing"
      hitSlop={8}
    >
      <View style={[styles.dot, styles[state.tone]]} />
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
  repairing: { backgroundColor: theme.colors.warning.default },
  disconnected: { backgroundColor: theme.colors.danger.default },
}))
