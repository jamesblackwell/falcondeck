import { memo, useCallback, useSyncExternalStore } from 'react'
import { View } from 'react-native'
import { Check, CircleX, Copy, Square, Volume2 } from 'lucide-react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import { ActivityDiamond, Button } from '@/components/ui'
import { readAloudPlayer } from '@/features/speech/readAloud'
import { useClipboardCopy } from '@/hooks/useClipboardCopy'

function copyTarget(accessibilityLabel: string) {
  const target = accessibilityLabel.replace(/^copy\s+/i, '').trim()
  return target || 'content'
}

export const MessageActions = memo(function MessageActions({
  text,
  accessibilityLabel = 'Copy response',
  readAloudKey,
}: {
  text: string
  accessibilityLabel?: string
  readAloudKey?: string
}) {
  const { theme } = useUnistyles()
  const target = copyTarget(accessibilityLabel)
  const successLabel = `${target[0]?.toUpperCase() ?? ''}${target.slice(1)} copied`
  const failureLabel = `Could not copy ${target}`
  const { copy, result } = useClipboardCopy(text, successLabel, failureLabel)
  const subscribe = useCallback(
    (listener: () => void) => readAloudPlayer.subscribe(readAloudKey ?? '', listener),
    [readAloudKey],
  )
  const getSnapshot = useCallback(
    () => readAloudKey ? readAloudPlayer.getSnapshot(readAloudKey) : 'idle' as const,
    [readAloudKey],
  )
  const speechState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  if (!text.trim()) return null

  const currentAccessibilityLabel = result === 'copied'
    ? successLabel
    : result === 'failed'
      ? `${failureLabel}. Retry`
      : accessibilityLabel
  const icon = result === 'copied' ? (
    <Check size={theme.iconSize.xs} color={theme.colors.success.default} />
  ) : result === 'failed' ? (
    <CircleX size={theme.iconSize.xs} color={theme.colors.danger.default} />
  ) : (
    <Copy size={theme.iconSize.xs} color={theme.colors.fg.muted} />
  )

  const readAloudIcon = speechState === 'loading' ? (
    <ActivityDiamond size={theme.iconSize.xs} color={theme.colors.fg.muted} />
  ) : speechState === 'playing' || speechState === 'paused' ? (
    <Square size={theme.iconSize.xs} color={theme.colors.fg.muted} />
  ) : speechState === 'error' ? (
    <CircleX size={theme.iconSize.xs} color={theme.colors.danger.default} />
  ) : (
    <Volume2 size={theme.iconSize.xs} color={theme.colors.fg.muted} />
  )
  const readAloudLabel = speechState === 'loading'
    ? 'Stop preparing Read Aloud'
    : speechState === 'playing' || speechState === 'paused'
      ? 'Stop Read Aloud'
      : speechState === 'error'
        ? 'Read Aloud failed. Retry'
        : 'Read aloud'

  return (
    <View style={styles.row} accessible={false}>
      <Button
        variant="ghost"
        size="icon"
        accessibilityLabel={currentAccessibilityLabel}
        accessibilityLiveRegion="polite"
        icon={icon}
        onPress={() => { void copy() }}
      />
      {readAloudKey ? (
        <Button
          variant="ghost"
          size="icon"
          accessibilityLabel={readAloudLabel}
          accessibilityLiveRegion="polite"
          accessibilityState={{ busy: speechState === 'loading' }}
          icon={readAloudIcon}
          onPress={() => readAloudPlayer.toggle(readAloudKey, text)}
        />
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[0],
  },
}))
