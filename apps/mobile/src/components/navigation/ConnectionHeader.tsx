import { memo } from 'react'
import { Pressable } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

import type { MachinePresence } from '@falcondeck/client-core'

import { Badge } from '@/components/ui'

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

function connectionBadgeState(
  connectionStatus: string,
  isEncrypted: boolean,
  desktopOnline: boolean,
): { variant: 'success' | 'warning' | 'danger'; label: string } {
  const relayReady = connectionStatus === 'encrypted' && isEncrypted

  if (relayReady) {
    if (desktopOnline) return { variant: 'success', label: 'Connected' }
    return { variant: 'warning', label: 'Desktop offline' }
  }

  return {
    variant: connectionStatus === 'disconnected' ? 'danger' : 'warning',
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
  const badgeState = connectionBadgeState(connectionStatus, isEncrypted, desktopOnline)

  return (
    <Pressable style={styles.container} onPress={onPress} hitSlop={8}>
      <Badge variant={badgeState.variant} dot>
        {badgeState.label}
      </Badge>
    </Pressable>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: 'row',
    gap: theme.spacing[2],
  },
}))
