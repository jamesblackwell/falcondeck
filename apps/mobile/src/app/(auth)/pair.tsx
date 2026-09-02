import { useEffect, useCallback, useRef, useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Lock, ChevronDown, ChevronUp, QrCode } from 'lucide-react-native'
import { useRouter } from 'expo-router'
import { CameraView, useCameraPermissions } from 'expo-camera'

import { useRelayStore } from '@/store'
import { CONNECTION_COPY } from '@/lib/connection-copy'
import {
  parsePairingQr,
  type ParsedPairingQr,
} from '@/features/pairing/parsePairingQr'
import { DEMO_PAIRING_CODE } from '@/features/demo/demoData'
import { enterDemoMode } from '@/features/demo/enterDemoMode'
import { ActivityDiamond, Text, Button, Input } from '@/components/ui'

function connectionLabel(status: string, desktopOnline: boolean) {
  if (status === 'claiming') return CONNECTION_COPY.claiming
  if (status === 'connecting') return CONNECTION_COPY.connectingToRelay
  if (status === 'connected') {
    return desktopOnline
      ? CONNECTION_COPY.securing
      : CONNECTION_COPY.waitingForDesktop
  }
  if (status === 'disconnected') return CONNECTION_COPY.reconnecting
  return CONNECTION_COPY.connecting
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
  const [pendingScannedPairing, setPendingScannedPairing] = useState<ParsedPairingQr | null>(null)
  const [permission, requestPermission] = useCameraPermissions()
  const hasHandledScanRef = useRef(false)

  const isClaiming = connectionStatus === 'claiming'
  const isSecuringSession = !!sessionId && !isEncrypted
  const desktopOnline = machinePresence?.daemon_connected ?? false

  // The handshake normally completes within seconds. If it has been spinning
  // far longer, say so instead of letting the spinner run silently forever.
  const [securingTooLong, setSecuringTooLong] = useState(false)
  useEffect(() => {
    if (!isSecuringSession) {
      setSecuringTooLong(false)
      return
    }
    const timer = setTimeout(() => setSecuringTooLong(true), 45_000)
    return () => clearTimeout(timer)
  }, [isSecuringSession])

  const handleConnect = useCallback(() => {
    if (isSecuringSession) return
    if (pairingCode.trim().toUpperCase() === DEMO_PAIRING_CODE) {
      enterDemoMode()
      router.replace('/(app)')
      return
    }
    void claimPairing()
  }, [claimPairing, isSecuringSession, pairingCode, router])

  const handleExploreDemo = useCallback(() => {
    enterDemoMode()
    router.replace('/(app)')
  }, [router])

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
      setShowScanner(false)
      if (parsed.requiresRelayConfirmation) {
        setPendingScannedPairing(parsed)
        return
      }
      // Set store values then claim — zustand updates are synchronous.
      setRelayUrl(parsed.relayUrl)
      setPairingCode(parsed.pairingCode)
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
    setPendingScannedPairing(null)
    hasHandledScanRef.current = false
    void disconnect()
  }, [disconnect])

  const acceptScannedRelay = useCallback(() => {
    if (!pendingScannedPairing) return
    setRelayUrl(pendingScannedPairing.relayUrl)
    setPairingCode(pendingScannedPairing.pairingCode)
    setPendingScannedPairing(null)
    void claimPairing()
  }, [claimPairing, pendingScannedPairing, setPairingCode, setRelayUrl])

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
      <View
        style={[
          styles.container,
          { paddingTop: insets.top, paddingBottom: insets.bottom },
        ]}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.hero}>
            <Text
              variant="heading"
              size="2xl"
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.5}
            >
              FalconDeck
            </Text>
            <Text variant="supporting" color="tertiary" style={styles.subtitle}>
              Connect to your desktop agent
            </Text>
          </View>

          {isSecuringSession ? (
            <View style={styles.connectingState}>
              <ActivityDiamond size={theme.iconSize.md} color={theme.colors.accent.default} />
              <Text variant="label" color="primary" weight="semibold" style={styles.centeredText}>
                {connectionLabel(connectionStatus, desktopOnline)}
              </Text>
              <Text variant="caption" color="muted" style={styles.centeredText}>
                {desktopOnline
                  ? CONNECTION_COPY.securingDetail
                  : CONNECTION_COPY.waitingForDesktopDetail}
              </Text>
              {error ? (
                <Text variant="caption" color="danger" style={styles.centeredText}>
                  {error}
                </Text>
              ) : null}
              {securingTooLong && !error ? (
                <Text variant="caption" color="danger" style={styles.centeredText}>
                  This is taking longer than expected. Check that FalconDeck
                  is running on your computer, or start over to pair again.
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
              <View style={styles.pairPanel}>
                {pendingScannedPairing ? (
                  <View style={styles.relayReview} accessibilityRole="alert">
                    <Text variant="label" color="primary" weight="semibold">
                      Review self-hosted relay
                    </Text>
                    <Text variant="caption" color="muted">
                      This QR code will connect FalconDeck to {new URL(pendingScannedPairing.relayUrl).host}.
                      Only continue if you recognise and trust this server.
                    </Text>
                    <View style={styles.relayReviewActions}>
                      <Button
                        variant="ghost"
                        size="sm"
                        label="Cancel"
                        onPress={() => setPendingScannedPairing(null)}
                      />
                      <Button
                        variant="danger"
                        size="sm"
                        label="Use this relay"
                        accessibilityLabel="Use scanned self-hosted relay"
                        onPress={acceptScannedRelay}
                      />
                    </View>
                  </View>
                ) : null}

                <Button
                  variant="default"
                  size="lg"
                  label="Scan QR code"
                  icon={<QrCode size={theme.iconSize.md} color={theme.colors.surface[0]} />}
                  onPress={handleScanPress}
                  disabled={isClaiming}
                />

                <View style={styles.divider}>
                  <View style={styles.dividerLine} />
                  <Text variant="microlabel">or enter the code</Text>
                  <View style={styles.dividerLine} />
                </View>

                <Input
                  value={pairingCode}
                  onChangeText={setPairingCode}
                  placeholder="Pairing code"
                  accessibilityLabel="Secure pairing code"
                  accessibilityHint="Paste the complete secure code shown by FalconDeck on your desktop"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="go"
                  onSubmitEditing={handleConnect}
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
                  <Text
                    variant="caption"
                    color="danger"
                    style={styles.centeredText}
                    accessibilityRole="alert"
                    accessibilityLiveRegion="assertive"
                  >
                    {error}
                  </Text>
                ) : null}
              </View>

              <View style={styles.demoPanel}>
                <Text variant="label" color="secondary" weight="semibold">
                  Just looking around?
                </Text>
                <Text variant="caption" color="muted" style={styles.demoHint}>
                  Open a sample workspace with example conversations. No pairing,
                  no sign-in, and nothing touches your computer.
                </Text>
                <Button
                  variant="outline"
                  size="sm"
                  label="Explore demo workspace"
                  onPress={handleExploreDemo}
                  disabled={isClaiming}
                />
              </View>
            </>
          )}
        </ScrollView>

        <View style={styles.bottom}>
          {!isSecuringSession && showAdvanced ? (
            <View style={styles.advancedPanel}>
              <Text variant="label" color="secondary" style={styles.advancedLabel}>
                Relay server URL
              </Text>
              <Text variant="caption" color="muted" style={styles.advancedHint}>
                Only change this when using a self-hosted FalconDeck relay.
              </Text>
              <Input
                value={relayUrl}
                onChangeText={setRelayUrl}
                placeholder="https://relay.example.com"
                accessibilityLabel="Relay URL"
                accessibilityHint="Enter the address of your self-hosted FalconDeck relay server"
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
            accessibilityRole="button"
            accessibilityLabel="Self-hosted relay settings"
            accessibilityHint={showAdvanced ? 'Hides relay server settings' : 'Shows relay server settings'}
            accessibilityState={{
              disabled: isSecuringSession,
              expanded: showAdvanced,
            }}
          >
            <Text variant="caption" color="muted" size="2xs">
              Self-hosted relay settings
            </Text>
            {showAdvanced ? (
              <ChevronUp size={12} color={theme.colors.fg.muted} />
            ) : (
              <ChevronDown size={12} color={theme.colors.fg.muted} />
            )}
          </Pressable>

          <View style={styles.footer}>
            <Lock size={11} color={theme.colors.fg.faint} />
            <Text variant="meta" size="2xs">
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
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: theme.spacing[8],
    paddingVertical: theme.spacing[8],
  },
  hero: {
    alignItems: 'center',
    gap: theme.spacing[1],
  },
  subtitle: {
    textAlign: 'center',
  },
  /** Everything the primary path needs: scan, or type the code and connect. */
  pairPanel: {
    width: '100%',
    maxWidth: 320,
    gap: theme.spacing[3],
  },
  relayReview: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.danger.default,
    backgroundColor: theme.colors.surface[1],
  },
  relayReviewActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.spacing[2],
  },
  /** The demo is a side door, so it sits apart from the pairing controls
      rather than as a fourth button in the same stack. */
  demoPanel: {
    width: '100%',
    maxWidth: 320,
    alignItems: 'center',
    gap: theme.spacing[2],
    padding: theme.spacing[4],
    borderRadius: theme.radius.xl,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: theme.colors.border.subtle,
    backgroundColor: theme.colors.surface[1],
  },
  connectingState: {
    width: '100%',
    maxWidth: 320,
    alignItems: 'center',
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[4],
  },
  centeredText: {
    textAlign: 'center',
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
  demoHint: {
    textAlign: 'center',
  },
  bottom: {
    alignItems: 'center',
    gap: theme.spacing[2],
    paddingTop: theme.spacing[2],
  },
  advancedPanel: {
    width: '100%',
    maxWidth: 320,
    gap: theme.spacing[1],
  },
  advancedLabel: {
    alignSelf: 'flex-start',
  },
  advancedHint: {
    lineHeight: theme.fontSize.xs * theme.lineHeight.normal,
  },
  advancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[1],
    minHeight: 44,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
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
