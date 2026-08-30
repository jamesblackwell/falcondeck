import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Pressable, View, type AppStateStatus } from 'react-native'
import * as Updates from 'expo-updates'
import { RotateCcw } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import { Spinner, Text } from '@/components/ui'

/**
 * Makes an update downloaded after launch actionable without requiring a full
 * app quit. Expo already checks on cold launch; this extra check covers a user
 * returning to an app that has stayed alive in the background.
 */
export const OtaUpdateBanner = memo(function OtaUpdateBanner() {
  const { theme } = useUnistyles()
  const insets = useSafeAreaInsets()
  const update = Updates.useUpdates()
  const actionInFlight = useRef(false)
  const shouldSkipForegroundCheck = useRef(false)
  const [isApplying, setIsApplying] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  shouldSkipForegroundCheck.current =
    update.isChecking ||
    update.isUpdateAvailable ||
    update.isUpdatePending ||
    update.isDownloading ||
    update.isRestarting

  useEffect(() => {
    if ((typeof __DEV__ !== 'undefined' && __DEV__) || !Updates.isEnabled) return

    let previousState: AppStateStatus = AppState.currentState
    const subscription = AppState.addEventListener('change', (nextState) => {
      const becameActive = previousState !== 'active' && nextState === 'active'
      previousState = nextState
      if (!becameActive || shouldSkipForegroundCheck.current) return

      // A failed background check should not interrupt the user. Download and
      // reload failures are surfaced only once there is an update to act on.
      void Updates.checkForUpdateAsync().catch(() => {})
    })

    return () => subscription.remove()
  }, [])

  const applyUpdate = useCallback(async () => {
    if (actionInFlight.current || update.isDownloading || update.isRestarting) return

    actionInFlight.current = true
    setActionError(null)
    setIsApplying(true)

    try {
      if (!update.isUpdatePending) {
        let updateAvailable = update.isUpdateAvailable
        if (!updateAvailable) {
          const check = await Updates.checkForUpdateAsync()
          updateAvailable = check.isAvailable || check.isRollBackToEmbedded
        }

        if (!updateAvailable) {
          throw new Error('The update is no longer available.')
        }

        const fetched = await Updates.fetchUpdateAsync()
        if (!fetched.isNew && !fetched.isRollBackToEmbedded) {
          throw new Error('The update could not be downloaded.')
        }
      }

      // Do not put cleanup after this await. Expo resolves immediately before
      // scheduling the native reload, so subsequent JS is not guaranteed to run.
      await Updates.reloadAsync()
    } catch {
      actionInFlight.current = false
      setIsApplying(false)
      setActionError('Couldn\'t refresh FalconDeck. Tap to try again.')
    }
  }, [update.isDownloading, update.isRestarting, update.isUpdateAvailable, update.isUpdatePending])

  const hasDownloadError = !!update.downloadError
  const hasError = !isApplying && (actionError !== null || hasDownloadError)
  const isBusy = isApplying || update.isDownloading || update.isRestarting
  const isVisible =
    update.isUpdateAvailable ||
    update.isUpdatePending ||
    update.isDownloading ||
    update.isRestarting ||
    actionError !== null ||
    hasDownloadError

  if (!isVisible) return null

  const title = hasError
    ? 'Update failed'
    : update.isRestarting || (isApplying && update.isUpdatePending)
      ? 'Refreshing FalconDeck…'
      : isBusy
        ? 'Downloading update…'
        : update.isUpdatePending
          ? 'Update ready'
          : 'Update available'
  const detail = hasError
    ? (actionError ?? 'Tap to try again')
    : isBusy
      ? 'This should only take a moment'
      : 'Tap to refresh FalconDeck'
  const tint = hasError ? theme.colors.danger.default : theme.colors.accent.default

  return (
    <Pressable
      onPress={() => void applyUpdate()}
      disabled={isBusy}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${detail}`}
      accessibilityHint="Downloads the update if needed, then refreshes the app"
      accessibilityState={{ disabled: isBusy }}
      accessibilityLiveRegion="polite"
      style={({ pressed }) => [
        styles.container,
        { paddingTop: insets.top },
        hasError ? styles.error : styles.update,
        pressed && !isBusy ? styles.pressed : undefined,
      ]}
    >
      <View style={styles.content}>
        {isBusy ? (
          <Spinner size={theme.iconSize.sm} color={tint} />
        ) : (
          <RotateCcw accessible={false} size={theme.iconSize.sm} color={tint} />
        )}
        <View style={styles.copy}>
          <Text variant="label" size="sm" weight="semibold" color={hasError ? 'danger' : 'primary'}>
            {title}
          </Text>
          <Text variant="caption" size="xs" color={hasError ? 'danger' : 'secondary'}>
            {detail}
          </Text>
        </View>
      </View>
    </Pressable>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    position: 'absolute',
    top: 0,
    right: 0,
    left: 0,
    zIndex: 1_000,
    borderBottomWidth: 1,
    ...theme.shadow.md,
  },
  update: {
    backgroundColor: theme.colors.surface[2],
    borderBottomColor: theme.colors.accent.default,
  },
  error: {
    backgroundColor: theme.colors.surface[2],
    borderBottomColor: theme.colors.danger.default,
  },
  pressed: {
    opacity: 0.82,
  },
  content: {
    minHeight: theme.minTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  copy: {
    flex: 1,
  },
}))
