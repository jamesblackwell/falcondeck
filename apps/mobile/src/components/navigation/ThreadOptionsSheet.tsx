import { memo, useCallback, useState } from 'react'
import { Pressable, View } from 'react-native'
import { Archive, ChevronRight, Pencil, Pin } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import type { ThreadSummary } from '@falcondeck/client-core'

import { Button, Input, NativeSheet, Text } from '@/components/ui'
import { useThreadActions } from '@/hooks/useThreadActions'

interface ThreadOptionsSheetProps {
  workspaceId: string
  thread: ThreadSummary
  onClose: () => void
}

export const ThreadOptionsSheet = memo(function ThreadOptionsSheet({
  workspaceId,
  thread,
  onClose,
}: ThreadOptionsSheetProps) {
  const { theme } = useUnistyles()
  const { archiveThread, renameThread, setThreadPinned, markThreadUnread } =
    useThreadActions()
  const [mode, setMode] = useState<'menu' | 'rename'>('menu')
  const [renameValue, setRenameValue] = useState(thread.title)
  const [pendingAction, setPendingAction] = useState<
    'archive' | 'rename' | 'pin' | 'unread' | null
  >(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const handleTogglePin = useCallback(async () => {
    void Haptics.selectionAsync()
    setPendingAction('pin')
    setActionError(null)
    try {
      await setThreadPinned(workspaceId, thread.id, !thread.is_pinned)
      onClose()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to update pin')
    } finally {
      setPendingAction(null)
    }
  }, [onClose, setThreadPinned, thread.id, thread.is_pinned, workspaceId])

  // Unread is `last_agent_activity_seq > last_read_seq`, so a thread the agent
  // never replied in cannot be made unread — hide the row instead of offering
  // an action that would do nothing.
  const canMarkUnread =
    !thread.attention.unread && thread.attention.last_agent_activity_seq > 0

  const handleMarkUnread = useCallback(async () => {
    void Haptics.selectionAsync()
    setPendingAction('unread')
    setActionError(null)
    try {
      await markThreadUnread(
        workspaceId,
        thread.id,
        thread.attention.last_agent_activity_seq,
      )
      onClose()
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Failed to mark as unread',
      )
    } finally {
      setPendingAction(null)
    }
  }, [
    markThreadUnread,
    onClose,
    thread.attention.last_agent_activity_seq,
    thread.id,
    workspaceId,
  ])

  const handleArchive = useCallback(async () => {
    setPendingAction('archive')
    setActionError(null)
    try {
      await archiveThread(workspaceId, thread.id)
      onClose()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to archive thread')
    } finally {
      setPendingAction(null)
    }
  }, [archiveThread, onClose, thread.id, workspaceId])

  const handleRename = useCallback(async () => {
    const nextTitle = renameValue.trim()
    if (!nextTitle) {
      setActionError('Title cannot be empty')
      return
    }

    setPendingAction('rename')
    setActionError(null)
    try {
      await renameThread(workspaceId, thread.id, nextTitle)
      onClose()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to rename thread')
    } finally {
      setPendingAction(null)
    }
  }, [onClose, renameThread, renameValue, thread.id, workspaceId])

  const startRename = useCallback(() => {
    void Haptics.selectionAsync()
    setMode('rename')
    setActionError(null)
  }, [])

  return (
    <NativeSheet
      onClose={onClose}
      accessibilityLabel="Close thread options"
      contentStyle={styles.content}
    >
      <Text variant="label" color="primary" weight="semibold" style={styles.title}>
        {mode === 'rename' ? 'Rename thread' : 'Thread options'}
      </Text>
      <Text variant="caption" color="muted" numberOfLines={1} style={styles.subtitle}>
        {thread.title || 'New thread'}
      </Text>

      {mode === 'rename' ? (
        <>
          <Input
            value={renameValue}
            onChangeText={setRenameValue}
            placeholder="Thread title"
            autoFocus
            selectTextOnFocus
            style={styles.renameInput}
          />
          {actionError ? (
            <Text variant="caption" color="danger" style={styles.errorText}>
              {actionError}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Button
              variant="ghost"
              label="Cancel"
              onPress={onClose}
              disabled={pendingAction === 'rename'}
            />
            <Button
              label="Save"
              onPress={() => void handleRename()}
              loading={pendingAction === 'rename'}
              disabled={!renameValue.trim()}
            />
          </View>
        </>
      ) : (
        <>
          <Pressable
            style={styles.item}
            accessibilityRole="button"
            accessibilityLabel={thread.is_pinned ? 'Unpin thread' : 'Pin thread'}
            onPress={() => void handleTogglePin()}
            disabled={pendingAction === 'pin'}
          >
            <View style={styles.itemLabel}>
              <Pin size={theme.iconSize.sm} color={theme.colors.fg.secondary} />
              <Text variant="label" color="primary">
                {thread.is_pinned ? 'Unpin' : 'Pin'}
              </Text>
            </View>
          </Pressable>
          <Pressable
            style={styles.item}
            accessibilityRole="button"
            accessibilityLabel="Rename thread"
            onPress={startRename}
          >
            <View style={styles.itemLabel}>
              <Pencil size={theme.iconSize.sm} color={theme.colors.fg.secondary} />
              <Text variant="label" color="primary">Rename</Text>
            </View>
            {/* The only row that opens something rather than acting on the
                thread, so it is the only one that earns a chevron. */}
            <ChevronRight size={theme.iconSize.xs} color={theme.colors.fg.muted} />
          </Pressable>
          {canMarkUnread ? (
            <Pressable
              style={styles.item}
              accessibilityRole="button"
              accessibilityLabel="Mark thread as unread"
              onPress={() => void handleMarkUnread()}
              disabled={pendingAction === 'unread'}
            >
              <View style={styles.itemLabel}>
                <View style={styles.unreadDot} />
                <Text variant="label" color="primary">Mark as unread</Text>
              </View>
            </Pressable>
          ) : null}
          <Pressable
            style={[styles.item, styles.dangerItem]}
            accessibilityRole="button"
            accessibilityLabel="Archive thread"
            onPress={() => void handleArchive()}
            disabled={pendingAction === 'archive'}
          >
            <View style={styles.itemLabel}>
              <Archive size={theme.iconSize.sm} color={theme.colors.danger.default} />
              <Text variant="label" color="danger">Archive</Text>
            </View>
          </Pressable>
          {actionError ? (
            <Text variant="caption" color="danger" style={styles.errorText}>
              {actionError}
            </Text>
          ) : null}
        </>
      )}
    </NativeSheet>
  )
})

const styles = StyleSheet.create((theme) => ({
  content: {
    paddingHorizontal: theme.spacing[4],
  },
  title: {
    paddingHorizontal: theme.spacing[2],
  },
  subtitle: {
    paddingHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: theme.minTouchTarget,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface[2],
    marginBottom: theme.spacing[2],
  },
  itemLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[3],
  },
  // Sized into the same box the lucide icons occupy so the labels line up.
  unreadDot: {
    width: theme.iconSize.sm,
    height: theme.iconSize.sm,
    alignSelf: 'center',
    borderRadius: theme.iconSize.sm / 2,
    backgroundColor: theme.colors.info.default,
    transform: [{ scale: 0.5 }],
  },
  dangerItem: {
    backgroundColor: theme.colors.danger.muted,
  },
  renameInput: {
    marginTop: theme.spacing[2],
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.spacing[2],
    marginTop: theme.spacing[3],
  },
  errorText: {
    marginTop: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
  },
}))
