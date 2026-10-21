import { memo, useCallback, useMemo } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Bot, Pin } from 'lucide-react-native'

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
  /**
   * Rung in the spawn tree: 0 draws a plain row, deeper values indent and draw
   * the elbow back up to the chat that started this one.
   */
  depth?: number
  /**
   * Rungs whose upright keeps running below this row, as packed by
   * `nestSpawnedThreads`. Ancestor uprights pass straight through.
   */
  trunkMask?: number
}

/** Rung width, and where in it the connector's upright sits. */
const NESTING_RUNG = 14
const NESTING_LINE = 6

function SessionListItemInner({
  thread,
  workspaceId,
  isSelected,
  onSelectThread,
  onOpenThreadOptions,
  nowTick = 0,
  tags = [],
  depth = 0,
  trunkMask = 0,
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
      style={({ pressed }) => [
        styles.container,
        isSelected ? styles.selected : pressed ? styles.pressed : undefined,
      ]}
      onPress={handlePress}
      onLongPress={handleLongPress}
    >
      {depth > 0 ? (
        // The elbow sits inside the row so the selection fill runs behind it.
        // Negative vertical margins reach into the row's padding, so a middle
        // child's upright meets the next sibling's with no seam.
        <View
          testID="thread-nesting-connector"
          pointerEvents="none"
          style={[styles.nesting, { width: depth * NESTING_RUNG }]}
        >
          <View
            style={[
              styles.nestingElbow,
              {
                left: (depth - 1) * NESTING_RUNG + NESTING_LINE,
                borderColor: theme.colors.border.emphasis,
              },
            ]}
          />
          {Array.from({ length: depth }, (_, index) => index + 1)
            .filter(rung => trunkMask & (1 << (rung - 1)))
            .map(rung => (
              <View
                key={rung}
                style={[
                  styles.nestingTrunk,
                  {
                    left: (rung - 1) * NESTING_RUNG + NESTING_LINE,
                    // This row's own rung carries on from the elbow; an
                    // ancestor's runs the whole height, under the row.
                    top: rung === depth ? '50%' : 0,
                    backgroundColor: theme.colors.border.emphasis,
                  },
                ]}
              />
            ))}
        </View>
      ) : null}
      <View style={styles.indicatorSlot}>
        {presentation.showSpinner ? (
          <ActivityDiamond size={14} color={theme.colors.accent.default} />
        ) : presentation.level === 'error' ? (
          <View style={[styles.dot, { backgroundColor: theme.colors.danger.default }]} />
        ) : presentation.level === 'awaiting_response' ? (
          <View style={[styles.dot, { backgroundColor: theme.colors.warning.default }]} />
        ) : presentation.showUnreadDot ? (
          <View style={[styles.dot, { backgroundColor: theme.colors.unread }]} />
        ) : null}
      </View>
      {/* Regular, not label: Geist only ships Regular/Bold, so weight 500
          rounds to Bold and these rows look heavier than desktop. */}
      <Text
        variant="body"
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
      {thread.origin?.kind === 'agent_spawn' && depth === 0 ? (
        // Nested rows skip the mark: the elbow already says an agent started
        // them, and the row spends the space on its title instead.
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel="Created by an agent"
        >
          <Bot size={theme.iconSize.xs} color={theme.colors.fg.muted} />
        </View>
      ) : null}
      {thread.is_pinned || thread.is_pinned_in_project ? (
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={thread.is_pinned ? 'Pinned' : 'Pinned in project'}
          style={styles.pin}
        >
          <Pin size={theme.iconSize.xs} color={theme.colors.fg.muted} />
        </View>
      ) : null}
      {presentation.showBadge ? (
        <Badge variant="success">{presentation.badgeLabel ?? 'Awaiting response'}</Badge>
      ) : (
        <Text variant="meta" color="muted">
          {updatedAtLabel}
        </Text>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create((theme) => ({
  // Inset from the panel edge so the selection reads as a rounded pill, the
  // way iOS 26 sidebars draw it, rather than a full-bleed band.
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: theme.minTouchTarget,
    marginHorizontal: theme.spacing[2],
    paddingLeft: theme.spacing[1],
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.radius.lg,
    borderCurve: 'continuous',
    gap: theme.spacing[1.5],
  },
  selected: {
    backgroundColor: theme.colors.accent.muted,
  },
  pressed: {
    backgroundColor: theme.isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(9, 9, 11, 0.045)',
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
  nesting: {
    alignSelf: 'stretch',
    marginVertical: -theme.spacing[2],
  },
  nestingElbow: {
    position: 'absolute',
    top: 0,
    height: '50%',
    right: 2,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomLeftRadius: theme.radius.sm,
    borderCurve: 'continuous',
  },
  nestingTrunk: {
    position: 'absolute',
    bottom: 0,
    width: StyleSheet.hairlineWidth,
  },
  tags: { flexDirection: 'row', alignItems: 'center' },
  pin: {
    // lucide-react-native copies style onto each path, so rotate the wrapper.
    transform: [{ rotate: '45deg' }],
  },
}))

const areEqual = (prev: SessionListItemProps, next: SessionListItemProps) =>
  prev.thread === next.thread &&
  prev.workspaceId === next.workspaceId &&
  prev.isSelected === next.isSelected &&
  prev.nowTick === next.nowTick &&
  prev.onSelectThread === next.onSelectThread &&
  prev.onOpenThreadOptions === next.onOpenThreadOptions &&
  prev.tags === next.tags &&
  prev.depth === next.depth &&
  prev.trunkMask === next.trunkMask

export const SessionListItem = memo(SessionListItemInner, areEqual)
