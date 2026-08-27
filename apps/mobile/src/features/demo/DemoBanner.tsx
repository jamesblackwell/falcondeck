import { memo, useCallback } from 'react'
import { View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { FlaskConical } from 'lucide-react-native'
import { useRouter } from 'expo-router'

import { Button, Text } from '@/components/ui'
import { useRelayStore } from '@/store'

import { isDemoSession } from './demoRpc'

/** Names the sample workspace for what it is, so simulated replies are never
    mistaken for a real agent, and offers the way out to real pairing. */
export const DemoBanner = memo(function DemoBanner() {
  const { theme } = useUnistyles()
  const router = useRouter()
  const sessionId = useRelayStore((s) => s.sessionId)

  const handleExit = useCallback(async () => {
    await useRelayStore.getState().disconnect()
    router.replace('/(auth)/pair')
  }, [router])

  if (!isDemoSession(sessionId)) return null

  return (
    <View style={styles.container}>
      <FlaskConical size={theme.iconSize.xs} color={theme.colors.info.default} />
      <Text variant="caption" size="xs" color="info" style={styles.message}>
        Demo workspace — responses are simulated
      </Text>
      <Button variant="ghost" size="sm" label="Pair a desktop" onPress={handleExit} />
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[1],
    backgroundColor: theme.colors.info.muted,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.subtle,
  },
  message: {
    flex: 1,
  },
}))
