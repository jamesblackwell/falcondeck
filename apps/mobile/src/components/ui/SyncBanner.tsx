import { memo, useEffect, useState } from 'react'
import { View } from 'react-native'
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { CloudOff } from 'lucide-react-native'

import type { SessionSyncStatus } from '@/lib/session-status'
import { Spinner } from './Spinner'
import { Text } from './Text'

interface SyncBannerProps {
  status: SessionSyncStatus
}

const SYNC_GRACE_PERIOD_MS = 7_000

/**
 * The launch/reconnect wait, made visible. Until the relay is secured and the
 * first snapshot lands, taps on "New thread" produce a screen that cannot send
 * anything yet — silence that reads as a frozen app. This says what is
 * happening and disappears the moment the session is usable.
 */
export const SyncBanner = memo(function SyncBanner({ status }: SyncBannerProps) {
  if (!status.isBusy) return null

  if (status.stage === 'syncing') {
    return <DelayedSyncBanner status={status} />
  }

  return <SyncBannerContent status={status} />
})

function DelayedSyncBanner({ status }: SyncBannerProps) {
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    const elapsed =
      status.syncStartedAt === null ? 0 : Math.max(0, Date.now() - status.syncStartedAt)
    const remaining = Math.max(0, SYNC_GRACE_PERIOD_MS - elapsed)

    if (remaining === 0) {
      setIsVisible(true)
      return
    }

    const timer = setTimeout(() => setIsVisible(true), remaining)
    return () => clearTimeout(timer)
  }, [status.syncStartedAt])

  return isVisible ? <SyncBannerContent status={status} /> : null
}

function SyncBannerContent({ status }: SyncBannerProps) {
  const { theme } = useUnistyles()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!status.isBusy || status.syncStartedAt === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [status.isBusy, status.syncStartedAt])

  const elapsedSeconds =
    status.syncStartedAt === null
      ? 0
      : Math.max(0, Math.floor((now - status.syncStartedAt) / 1_000))
  const retrySeconds =
    status.nextRetryAt === null ? null : Math.max(0, Math.ceil((status.nextRetryAt - now) / 1_000))
  const hasWaitedLongEnoughForDetails = elapsedSeconds >= 30
  const timingDetail = hasWaitedLongEnoughForDetails
    ? [
        `Waiting ${elapsedSeconds}s`,
        `attempt ${Math.max(status.syncAttempt, 1)}`,
        retrySeconds === null ? null : `retry in ${retrySeconds}s`,
      ]
        .filter((part): part is string => part !== null)
        .join(' · ')
    : null
  const isStalled = status.stage === 'offline' || status.stage === 'repairing' || !!status.lastError
  const showsOfflineIcon = status.stage === 'offline'
  const tint = isStalled ? theme.colors.warning.default : theme.colors.info.default
  const accessibilityLabel = [
    status.label,
    status.detail,
    timingDetail,
    status.lastError ? `Last error: ${status.lastError}` : null,
  ]
    .filter((part): part is string => !!part)
    .join(' ')

  return (
    <Animated.View
      entering={FadeIn.duration(150)}
      exiting={FadeOut.duration(150)}
      layout={LinearTransition.duration(150)}
      style={[styles.container, isStalled ? styles.stalled : styles.busy]}
      accessibilityRole="progressbar"
      accessibilityLiveRegion="polite"
      accessibilityLabel={accessibilityLabel}
    >
      {showsOfflineIcon ? (
        <CloudOff accessible={false} size={theme.iconSize.xs} color={tint} />
      ) : (
        <Spinner size={theme.iconSize.xs} color={tint} />
      )}
      <View style={styles.message}>
        <Text variant="caption" size="xs" weight="medium" color="primary">
          {status.label}
        </Text>
        {status.detail ? (
          <Text variant="caption" size="xs" color="muted">
            {status.detail}
          </Text>
        ) : null}
        {timingDetail ? (
          <Text variant="caption" size="xs" color="muted">
            {timingDetail}
          </Text>
        ) : null}
        {status.lastError ? (
          <Text variant="caption" size="xs" color="warning">
            Last error: {status.lastError}
          </Text>
        ) : null}
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.subtle,
  },
  busy: {
    backgroundColor: theme.colors.info.muted,
  },
  stalled: {
    backgroundColor: theme.colors.warning.muted,
  },
  message: {
    flex: 1,
    gap: theme.spacing[1] / 2,
  },
}))
