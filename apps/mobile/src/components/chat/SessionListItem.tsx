import { memo, useCallback, useMemo } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import { deriveThreadAttentionPresentation } from '@falcondeck/client-core'
import type { ThreadSummary, ThreadTag } from '@falcondeck/client-core'

import { ActivityDiamond, Badge, Text } from '@/components/ui'
import { formatRelativeTime } from './sessionListItem.utils'
import { stageColor, ThreadStageMark } from './ThreadStageMark'

interface SessionListItemProps {
  thread: ThreadSummary
  workspaceId: string
  isSelected: boolean
  onSelectThread: (workspaceId: string, threadId: string) => void
  onOpenThreadOptions?: (workspaceId: string, thread: ThreadSummary) => void
  nowTick?: number
  tags?: ThreadTag[]
}

function SessionListItemInner({
  thread,
  workspaceId,
  isSelected,
  onSelectThread,
  onOpenThreadOptions,
  nowTick = 0,
  tags = [],
}: SessionListItemProps) {
  const { theme } = useUnistyles()
  const presentation = useMemo(() => deriveThreadAttentionPresentation(thread), [thread])
  const updatedAtLabel = useMemo(() => {
    // The parent advances this primitive once per minute to refresh relative
    // timestamps without replacing otherwise stable thread objects.
    void nowTick
    return formatRelativeTime(thread.updated_at)
  }, [nowTick, thread.updated_at])

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
      accessibilityRole="button"
      accessibilityHint="Double tap and hold for thread options"
      style={[styles.container, isSelected ? styles.selected : undefined]}
      onPress={handlePress}
      onLongPress={handleLongPress}
    >
      <View style={styles.indicatorSlot}>
        {presentation.showSpinner ? (
          <ActivityDiamond size={14} color={theme.colors.accent.default} />
        ) : presentation.level === 'error' ? (
          <View style={[styles.dot, { backgroundColor: theme.colors.danger.default }]} />
        ) : presentation.level === 'awaiting_response' ? (
          <View style={[styles.dot, { backgroundColor: theme.colors.warning.default }]} />
        ) : presentation.showUnreadDot ? (
          <View style={[styles.dot, { backgroundColor: theme.colors.info.default }]} />
        ) : null}
      </View>
      {/* Regular, not label: Geist only ships Regular/Bold, so weight 500
          rounds to Bold and these rows look heavier than desktop. */}
      <Text
        variant="supporting"
        color={isSelected ? 'primary' : 'secondary'}
        weight="normal"
        numberOfLines={1}
        style={styles.title}
      >
        {thread.title || 'New thread'}
      </Text>
      {tags.length > 0 ? (
        <View style={styles.tags} accessibilityLabel={tags.map(tag => tag.label).join(', ')}>
          {tags.slice(0, 1).map(tag => (
            <ThreadStageMark
              key={tag.id}
              stage={tag}
              color={stageColor(tag.color, theme)}
            />
          ))}
        </View>
      ) : null}
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
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.radius.md,
    borderCurve: 'continuous',
    gap: theme.spacing[1.5],
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
    borderRadius: theme.radius.full,
  },
  tags: { flexDirection: 'row', alignItems: 'center' },
}))

const areEqual = (prev: SessionListItemProps, next: SessionListItemProps) =>
  prev.thread === next.thread &&
  prev.workspaceId === next.workspaceId &&
  prev.isSelected === next.isSelected &&
  prev.nowTick === next.nowTick &&
  prev.onSelectThread === next.onSelectThread &&
  prev.onOpenThreadOptions === next.onOpenThreadOptions &&
  prev.tags === next.tags

export const SessionListItem = memo(SessionListItemInner, areEqual)
