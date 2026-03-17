import { memo, useCallback } from 'react'
import { Pressable } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Loader } from 'lucide-react-native'

import type { ThreadSummary } from '@falcondeck/client-core'

import { Text } from '@/components/ui'

interface SessionListItemProps {
  threadId: string
  title: string
  isRunning: boolean
  updatedAt: string
  isSelected: boolean
  onSelect: (threadId: string) => void
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  return `${days}d`
}

export const SessionListItem = memo(function SessionListItem({
  threadId,
  title,
  isRunning,
  updatedAt,
  isSelected,
  onSelect,
}: SessionListItemProps) {
  const { theme } = useUnistyles()

  /* v8 ignore start — Pressable callback, tested via E2E */
  const handlePress = useCallback(() => {
    onSelect(threadId)
  }, [threadId, onSelect])
  /* v8 ignore stop */

  return (
    <Pressable
      style={[styles.container, isSelected ? styles.selected : undefined]}
      onPress={handlePress}
    >
      <Text
        variant="label"
        color={isSelected ? 'primary' : 'secondary'}
        numberOfLines={1}
        style={styles.title}
      >
        {title}
      </Text>
      {isRunning ? (
        <Loader size={14} color={theme.colors.accent.default} />
      ) : (
        <Text variant="caption" color="muted" size="2xs">
          {timeAgo(updatedAt)}
        </Text>
      )}
    </Pressable>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.radius.md,
    borderCurve: 'continuous',
    gap: theme.spacing[2],
  },
  selected: {
    backgroundColor: theme.colors.accent.dim,
  },
  title: {
    flex: 1,
  },
}))
