import { memo } from 'react'
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

/**
 * The launch/reconnect wait, made visible. Until the relay is secured and the
 * first snapshot lands, taps on "New thread" produce a screen that cannot send
 * anything yet — silence that reads as a frozen app. This says what is
 * happening and disappears the moment the session is usable.
 */
export const SyncBanner = memo(function SyncBanner({ status }: SyncBannerProps) {
  const { theme } = useUnistyles()

  if (!status.isBusy) return null

  const isStalled = status.stage === 'offline'
  const tint = isStalled ? theme.colors.warning.default : theme.colors.info.default

  return (
    <Animated.View
      entering={FadeIn.duration(150)}
      exiting={FadeOut.duration(150)}
      layout={LinearTransition.duration(150)}
      style={[styles.container, isStalled ? styles.stalled : styles.busy]}
      accessibilityRole="progressbar"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${status.label} ${status.detail}`}
    >
      {isStalled ? (
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
      </View>
    </Animated.View>
  )
})

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
