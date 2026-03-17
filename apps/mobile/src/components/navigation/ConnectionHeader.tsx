import { memo } from 'react'
import { View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

import type { MachinePresence } from '@falcondeck/client-core'

import { Badge } from '@/components/ui'

interface ConnectionHeaderProps {
  connectionStatus: string
  isEncrypted: boolean
  machinePresence: MachinePresence | null
}

function connectionLabel(status: string): string {
  if (status === 'encrypted') return 'Encrypted'
  if (status === 'connected') return 'Connected'
  if (status === 'connecting') return 'Connecting...'
  if (status === 'disconnected') return 'Disconnected'
  return 'Not connected'
}

export const ConnectionHeader = memo(function ConnectionHeader({
  connectionStatus,
  isEncrypted,
  machinePresence,
}: ConnectionHeaderProps) {
  const desktopOnline = machinePresence?.daemon_connected ?? false

  return (
    <View style={styles.container}>
      <Badge
        variant={isEncrypted ? 'success' : connectionStatus === 'disconnected' ? 'danger' : 'warning'}
        dot
      >
        {connectionLabel(connectionStatus)}
      </Badge>
      <Badge variant={desktopOnline ? 'success' : 'warning'} dot>
        {desktopOnline ? 'Desktop online' : 'Desktop offline'}
      </Badge>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: 'row',
    gap: theme.spacing[2],
  },
}))
