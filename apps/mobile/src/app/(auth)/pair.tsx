import { useEffect, useCallback, useRef, useState } from 'react'
import { View, KeyboardAvoidingView, Platform, Pressable, ActivityIndicator } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Lock, ChevronDown, ChevronUp } from 'lucide-react-native'
import { useRouter } from 'expo-router'
import { CameraView, useCameraPermissions } from 'expo-camera'

import { useRelayStore } from '@/store'
import { parsePairingQr } from '@/features/pairing/parsePairingQr'
import { DEMO_PAIRING_CODE } from '@/features/demo/demoData'
import { enterDemoMode } from '@/features/demo/enterDemoMode'
import { Text, Button, Input } from '@/components/ui'

function connectionLabel(status: string, desktopOnline: boolean) {
  if (status === 'claiming') return 'Claiming pairing...'
  if (status === 'connecting') return 'Connecting to relay...'
  if (status === 'connected') {
    return desktopOnline ? 'Securing session...' : 'Waiting for desktop...'
  }
  if (status === 'disconnected') return 'Reconnecting...'
  return 'Connecting...'
}

export default function PairScreen() {
  const { theme } = useUnistyles()
  const insets = useSafeAreaInsets()
  const router = useRouter()

  const relayUrl = useRelayStore((s) => s.relayUrl)
  const pairingCode = useRelayStore((s) => s.pairingCode)
  const sessionId = useRelayStore((s) => s.sessionId)
  const connectionStatus = useRelayStore((s) => s.connectionStatus)
  const isEncrypted = useRelayStore((s) => s.isEncrypted)
  const machinePresence = useRelayStore((s) => s.machinePresence)
  const error = useRelayStore((s) => s.error)
  const { setRelayUrl, setPairingCode, claimPairing, disconnect, _setError } = useRelayStore.getState()

  const [showScanner, setShowScanner] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [permission, requestPermission] = useCameraPermissions()
  const hasHandledScanRef = useRef(false)

  const isClaiming = connectionStatus === 'claiming'
  const isSecuringSession = !!sessionId && !isEncrypted
  const desktopOnline = machinePresence?.daemon_connected ?? false

  const handleConnect = useCallback(() => {
    if (isSecuringSession) return
    if (pairingCode.trim().toUpperCase() === DEMO_PAIRING_CODE) {
      enterDemoMode()
      router.replace('/(app)')
      return
    }
    void claimPairing()
  }, [claimPairing, isSecuringSession, pairingCode, router])

  const handleScanPress = useCallback(async () => {
    hasHandledScanRef.current = false
    if (!permission?.granted) {
      const result = await requestPermission()
      if (!result.granted) return
    }
    setShowScanner(true)
  }, [permission, requestPermission])

  const handleBarCodeScanned = useCallback(
    ({ data }: { data: string }) => {
      if (hasHandledScanRef.current || isSecuringSession) {
        return
      }
      hasHandledScanRef.current = true
      const parsed = parsePairingQr(data)
      if (!parsed) {
        _setError('Invalid QR code')
        setShowScanner(false)
        return
      }
      if (parsed.pairingCode === DEMO_PAIRING_CODE) {
        enterDemoMode()
        setShowScanner(false)
        router.replace('/(app)')
        return
      }
      // Set store values then claim — zustand updates are synchronous
      setRelayUrl(parsed.relayUrl)
      setPairingCode(parsed.pairingCode)
      setShowScanner(false)
      void claimPairing()
    },
    [setRelayUrl, setPairingCode, claimPairing, _setError, isSecuringSession, router],
  )

  useEffect(() => {
    if (sessionId && isEncrypted) {
      router.replace('/(app)')
    }
  }, [isEncrypted, router, sessionId])

  useEffect(() => {
    if (!showScanner) {
      hasHandledScanRef.current = false
    }
  }, [showScanner])

  const handleStartOver = useCallback(() => {
    setShowScanner(false)
    hasHandledScanRef.current = false
    void disconnect()
  }, [disconnect])

  if (showScanner) {
    return (
      <View style={[styles.scannerContainer, { paddingTop: insets.top }]}>
        <View style={styles.scannerHeader}>
          <Text variant="label" color="primary" weight="semibold">
            Scan pairing QR code
          </Text>
          <Button variant="ghost" size="sm" label="Cancel" onPress={() => setShowScanner(false)} />
        </View>
        <View style={styles.scannerBody}>
          <CameraView
            style={styles.camera}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={handleBarCodeScanned}
          />
          <View style={styles.scanOverlay}>
            <View style={styles.scanFrame} />
          </View>
        </View>
        <View style={[styles.scannerFooter, { paddingBottom: insets.bottom + 16 }]}>
          <Text variant="caption" color="muted" style={styles.scanHint}>
            Scan the QR code shown on your desktop
          </Text>
        </View>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.content}>
          <View style={styles.hero}>
            <Text variant="heading">
              FalconDeck
            </Text>
            <Text variant="body" color="tertiary" style={styles.subtitle}>
              Connect to your desktop agent
            </Text>
          </View>

          <View style={styles.form}>
            {isSecuringSession ? (
              <View style={styles.connectingState}>
                <ActivityIndicator size="small" color={theme.colors.fg.muted} />
                <Text variant="label" color="primary" weight="semibold" style={styles.connectingTitle}>
                  {connectionLabel(connectionStatus, desktopOnline)}
                </Text>
                <Text variant="caption" color="muted" style={styles.connectingBody}>
                  {desktopOnline
                    ? 'Your desktop is finishing the encrypted handshake for this device.'
                    : 'Keep FalconDeck open on your desktop while it finishes pairing.'}
                </Text>
                {error ? (
                  <Text variant="caption" color="danger" style={styles.error}>
                    {error}
                  </Text>
                ) : null}
                <Button
                  variant="danger"
                  label="Start Over"
                  onPress={handleStartOver}
                />
              </View>
            ) : (
              <>
                <Button
                  variant="default"
                  size="lg"
                  label="Scan QR Code"
                  onPress={handleScanPress}
                  disabled={isClaiming}
                />

                <View style={styles.divider}>
                  <View style={styles.dividerLine} />
                  <Text variant="caption" color="muted" size="2xs">
                    OR ENTER CODE
                  </Text>
                  <View style={styles.dividerLine} />
                </View>

                <Input
                  value={pairingCode}
                  onChangeText={setPairingCode}
                  placeholder="Pairing code"
                  autoCapitalize="characters"
                  autoCorrect={false}
                  style={styles.codeInput}
                />

                <Button
                  variant="secondary"
                  label="Connect"
                  loading={isClaiming}
                  disabled={!relayUrl.trim() || !pairingCode.trim()}
                  onPress={handleConnect}
                />

                {error ? (
                  <Text variant="caption" color="danger" style={styles.error}>
                    {error}
                  </Text>
                ) : null}
              </>
            )}
          </View>
        </View>

        <View style={styles.bottom}>
          {!isSecuringSession && showAdvanced ? (
            <View style={styles.advancedPanel}>
              <Input
                value={relayUrl}
                onChangeText={setRelayUrl}
                placeholder="Relay URL"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
            </View>
          ) : null}

          <Pressable
            style={styles.advancedToggle}
            onPress={() => setShowAdvanced(!showAdvanced)}
            disabled={isSecuringSession}
          >
            <Text variant="caption" color="muted" size="2xs">
              Advanced
            </Text>
            {showAdvanced ? (
              <ChevronUp size={12} color={theme.colors.fg.muted} />
            ) : (
              <ChevronDown size={12} color={theme.colors.fg.muted} />
            )}
          </Pressable>

          <View style={styles.footer}>
            <Lock size={11} color={theme.colors.fg.faint} />
            <Text variant="caption" color="faint" size="2xs">
              End-to-end encrypted
            </Text>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create((theme) => ({
  flex: { flex: 1 },
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface[0],
    paddingHorizontal: theme.spacing[6],
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  hero: {
    alignItems: 'center',
    gap: theme.spacing[1],
    marginBottom: theme.spacing[10],
  },
  subtitle: {
    textAlign: 'center',
  },
  form: {
    width: '100%',
    maxWidth: 320,
    gap: theme.spacing[3],
  },
  connectingState: {
    alignItems: 'center',
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[4],
  },
  connectingTitle: {
    textAlign: 'center',
  },
  connectingBody: {
    textAlign: 'center',
    lineHeight: 20,
  },
  codeInput: {
    textAlign: 'center',
    fontFamily: theme.fontFamily.mono,
    letterSpacing: 4,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.border.subtle,
  },
  error: {
    textAlign: 'center',
  },
  bottom: {
    alignItems: 'center',
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  advancedPanel: {
    width: '100%',
    maxWidth: 320,
  },
  advancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[1],
  },
  // Scanner
  scannerContainer: {
    flex: 1,
    backgroundColor: theme.colors.surface[0],
  },
  scannerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  scannerBody: {
    flex: 1,
    position: 'relative',
  },
  camera: {
    flex: 1,
  },
  scanOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanFrame: {
    width: 240,
    height: 240,
    borderWidth: 2,
    borderColor: theme.colors.accent.default,
    borderRadius: theme.radius.xl,
  },
  scannerFooter: {
    alignItems: 'center',
    paddingTop: theme.spacing[4],
  },
  scanHint: {
    textAlign: 'center',
  },
}))
