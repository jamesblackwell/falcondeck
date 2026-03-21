import { useEffect, useCallback } from 'react'
import { View, KeyboardAvoidingView, Platform } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Smartphone, Lock } from 'lucide-react-native'
import { useRouter } from 'expo-router'

import { useRelayStore } from '@/store'
import { Text, Button, Input } from '@/components/ui'

export default function PairScreen() {
  const { theme } = useUnistyles()
  const insets = useSafeAreaInsets()
  const router = useRouter()

  const relayUrl = useRelayStore((s) => s.relayUrl)
  const pairingCode = useRelayStore((s) => s.pairingCode)
  const connectionStatus = useRelayStore((s) => s.connectionStatus)
  const error = useRelayStore((s) => s.error)
  const isConnected = useRelayStore((s) => s.isConnected)
  const { setRelayUrl, setPairingCode, claimPairing } = useRelayStore.getState()

  const isClaiming = connectionStatus === 'claiming'

  const handleConnect = useCallback(() => {
    void claimPairing()
  }, [claimPairing])

  // Navigate away once connected
  useEffect(() => {
    if (isConnected) {
      router.replace('/(app)')
    }
  }, [isConnected, router])

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.container, { paddingTop: insets.top + 40 }]}>
        <View style={styles.hero}>
          <View style={styles.iconCircle}>
            <Smartphone size={28} color={theme.colors.fg.tertiary} />
          </View>
          <Text variant="heading" size="xl" weight="semibold">
            FalconDeck Remote
          </Text>
          <Text variant="body" color="tertiary">
            Connect to your desktop session
          </Text>
        </View>

        <View style={styles.form}>
          <Input
            value={relayUrl}
            onChangeText={setRelayUrl}
            placeholder="Relay URL"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Input
            value={pairingCode}
            onChangeText={setPairingCode}
            placeholder="Pairing code"
            autoCapitalize="characters"
            autoCorrect={false}
            style={styles.codeInput}
          />
          <Button
            variant="default"
            label="Connect"
            loading={isClaiming}
            disabled={!relayUrl.trim() || !pairingCode.trim()}
            onPress={handleConnect}
          />
        </View>

        <View style={styles.footer}>
          <Lock size={12} color={theme.colors.fg.muted} />
          <Text variant="caption" color="muted">
            End-to-end encrypted
          </Text>
        </View>

        {error ? (
          <Text variant="body" color="danger" style={styles.error}>
            {error}
          </Text>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create((theme) => ({
  flex: { flex: 1 },
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface[0],
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing[6],
  },
  hero: {
    alignItems: 'center',
    gap: theme.spacing[2],
    marginBottom: theme.spacing[8],
  },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.colors.surface[2],
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: theme.spacing[2],
  },
  form: {
    width: '100%',
    maxWidth: 340,
    gap: theme.spacing[3],
  },
  codeInput: {
    textAlign: 'center',
    fontFamily: theme.fontFamily.mono,
    letterSpacing: 4,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    marginTop: theme.spacing[6],
  },
  error: {
    marginTop: theme.spacing[4],
    textAlign: 'center',
  },
}))
