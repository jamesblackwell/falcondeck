import { memo, useCallback } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Loader } from 'lucide-react-native'

import { deriveThreadAttentionPresentation } from '@falcondeck/client-core'
import type { ThreadSummary } from '@falcondeck/client-core'

import { Badge, Text } from '@/components/ui'

interface SessionListItemProps {
  threadId: string
  title: string
  isRunning: boolean
  updatedAt: string
  attention: ThreadSummary['attention']
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
  attention,
  isSelected,
  onSelect,
}: SessionListItemProps) {
  const { theme } = useUnistyles()
  const presentation = deriveThreadAttentionPresentation({
    id: threadId,
    workspace_id: '',
    title,
    provider: 'codex',
    status: isRunning ? 'running' : 'idle',
    updated_at: updatedAt,
    last_message_preview: null,
    latest_turn_id: null,
    latest_plan: null,
    latest_diff: null,
    last_tool: null,
    last_error: presentationError(attention),
    agent: {
      model_id: null,
      reasoning_effort: null,
      collaboration_mode_id: null,
      approval_policy: null,
      service_tier: null,
    },
    attention,
    is_archived: false,
  })

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
      <View style={styles.indicatorSlot}>
        {presentation.showSpinner ? (
          <Loader size={14} color={theme.colors.accent.default} />
        ) : presentation.level === 'error' ? (
          <View style={[styles.dot, { backgroundColor: theme.colors.danger.default }]} />
        ) : presentation.level === 'awaiting_response' ? (
          <View style={[styles.dot, { backgroundColor: theme.colors.warning.default }]} />
        ) : presentation.showUnreadDot ? (
          <View style={[styles.dot, { backgroundColor: theme.colors.info.default }]} />
        ) : (
          <View
            style={[
              styles.ring,
              {
                borderColor: theme.colors.fg.faint,
              },
            ]}
          />
        )}
      </View>
      <Text
        variant="label"
        color={isSelected ? 'primary' : 'secondary'}
        numberOfLines={1}
        style={styles.title}
      >
        {title}
      </Text>
      {presentation.showBadge ? (
        <Badge variant="success">{presentation.badgeLabel ?? 'Awaiting response'}</Badge>
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
  ring: {
    width: 12,
    height: 12,
    borderRadius: 999,
    borderWidth: 1,
  },
}))

function presentationError(attention: ThreadSummary['attention']) {
  return attention.level === 'error' ? 'Attention required' : null
}
