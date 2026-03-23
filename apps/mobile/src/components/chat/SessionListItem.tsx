import { memo, useCallback, useMemo } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Loader } from 'lucide-react-native'

import { deriveThreadAttentionPresentation } from '@falcondeck/client-core'
import type { ThreadSummary } from '@falcondeck/client-core'

import { Badge, Text } from '@/components/ui'
import { formatRelativeTime } from './sessionListItem.utils'

interface SessionListItemProps {
  thread: ThreadSummary
  workspaceId: string
  isSelected: boolean
  onSelectThread: (workspaceId: string, threadId: string) => void
  onOpenThreadOptions?: (workspaceId: string, thread: ThreadSummary) => void
  nowTick?: number
}

function SessionListItemInner({
  thread,
  workspaceId,
  isSelected,
  onSelectThread,
  onOpenThreadOptions,
  nowTick = 0,
}: SessionListItemProps) {
  const { theme } = useUnistyles()
  const presentation = useMemo(() => deriveThreadAttentionPresentation(thread), [thread])
  const updatedAtLabel = useMemo(
    () => formatRelativeTime(thread.updated_at),
    [nowTick, thread.updated_at],
  )

  /* v8 ignore start — Pressable callback, tested via E2E */
  const handlePress = useCallback(() => {
    onSelectThread(workspaceId, thread.id)
  }, [onSelectThread, thread.id, workspaceId])

  const handleLongPress = useCallback(() => {
    onOpenThreadOptions?.(workspaceId, thread)
  }, [onOpenThreadOptions, thread, workspaceId])
  /* v8 ignore stop */

  return (
    <Pressable
      style={[styles.container, isSelected ? styles.selected : undefined]}
      onPress={handlePress}
      onLongPress={handleLongPress}
    >
      <View style={styles.indicatorSlot}>
        {presentation.showSpinner ? (
          <Loader size={14} color={theme.colors.accent.default} />
        ) : presentation.level === 'error' ? (
          <View style={[styles.dot, { backgroundColor: theme.colors.danger.default }]} />
        ) : presentation.level === 'awaiting_response' ? (
          <View style={[styles.dot, { backgroundColor: theme.colors.warning.default }]} />
        ) : presentation.showUnreadDot ? (
          <View style={[styles.dot, { backgroundColor: theme.colors.info.default }]} />
        ) : null}
      </View>
      <Text
        variant="label"
        color={isSelected ? 'primary' : 'secondary'}
        numberOfLines={1}
        style={styles.title}
      >
        {thread.title || 'New thread'}
      </Text>
      {presentation.showBadge ? (
        <Badge variant="success">{presentation.badgeLabel ?? 'Awaiting response'}</Badge>
      ) : (
        <Text variant="caption" color="muted" size="2xs">
          {updatedAtLabel}
        </Text>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
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
  indicatorSlot: {
    width: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 999,
  },
}))

const areEqual = (prev: SessionListItemProps, next: SessionListItemProps) =>
  prev.thread === next.thread &&
  prev.workspaceId === next.workspaceId &&
  prev.isSelected === next.isSelected &&
  prev.nowTick === next.nowTick &&
  prev.onSelectThread === next.onSelectThread &&
  prev.onOpenThreadOptions === next.onOpenThreadOptions

export const SessionListItem = memo(SessionListItemInner, areEqual)
