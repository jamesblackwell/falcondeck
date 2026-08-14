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

export function connectionLabel(status: string): string {
  if (status === 'encrypted') return 'Connected'
  if (status === 'connected') return 'Securing session…'
  if (status === 'connecting') return 'Connecting…'
  if (status === 'disconnected') return 'Disconnected'
  if (status === 'claiming') return 'Pairing…'
  return 'Not connected'
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
    if (!daemonPresenceKnown) return { tone: 'repairing', label: 'Checking your Mac…' }
    if (!desktopOnline) return { tone: 'disconnected', label: 'Your Mac is offline' }
    if (!daemonRpcReady) return { tone: 'repairing', label: 'Sync repairing' }
    return { tone: 'connected', label: 'Connected' }
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
  const daemonRpcReady = machinePresence?.daemon_rpc_ready ?? desktopOnline
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
      accessibilityHint="Opens settings"
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
