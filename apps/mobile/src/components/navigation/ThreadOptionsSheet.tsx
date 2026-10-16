import { memo, useCallback, useRef, useState } from 'react'
import { Pressable, View } from 'react-native'
import { Archive, ArchiveRestore, FolderInput, Pencil, Pin, Sparkles } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import type { ThreadSummary } from '@falcondeck/client-core'

import { Button, Input, NativeSheet, SheetGroup, SheetRow, Text } from '@/components/ui'
import { useThreadActions } from '@/hooks/useThreadActions'
import { triggerThreadArchiveHaptic } from '@/lib/haptics'
import { useSessionStore } from '@/store/session-store'

interface ThreadOptionsSheetProps {
  workspaceId: string
  thread: ThreadSummary
  onClose: () => void
  onMoveToFolder?: () => void
}

export const ThreadOptionsSheet = memo(function ThreadOptionsSheet({
  workspaceId,
  thread,
  onClose,
  onMoveToFolder,
}: ThreadOptionsSheetProps) {
  const { theme } = useUnistyles()
  const {
    archiveThread,
    unarchiveThread,
    renameThread,
    suggestThreadTitle,
    setThreadPinned,
    setThreadPinnedInProject,
    markThreadUnread,
  } = useThreadActions()
  const canPinInProject = useSessionStore(
    (state) =>
      state.snapshot?.workspaces.find((workspace) => workspace.id === workspaceId)?.kind !==
      'casual',
  )
  const [mode, setMode] = useState<'menu' | 'rename'>('menu')
  const [renameValue, setRenameValue] = useState(thread.title)
  const [pendingAction, setPendingAction] = useState<
    'rename' | 'suggest' | 'pin' | 'pin-in-project' | 'unread' | null
  >(null)
  const pendingActionRef = useRef<typeof pendingAction>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const beginAction = useCallback((action: Exclude<typeof pendingAction, null>) => {
    if (pendingActionRef.current) return false
    pendingActionRef.current = action
    setPendingAction(action)
    setActionError(null)
    return true
  }, [])

  const finishAction = useCallback((action: Exclude<typeof pendingAction, null>) => {
    if (pendingActionRef.current !== action) return
    pendingActionRef.current = null
    setPendingAction(null)
  }, [])

  const handleTogglePin = useCallback(async () => {
    if (!beginAction('pin')) return
    void Haptics.selectionAsync()
    try {
      await setThreadPinned(workspaceId, thread.id, !thread.is_pinned)
      onClose()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to update pin')
    } finally {
      finishAction('pin')
    }
  }, [beginAction, finishAction, onClose, setThreadPinned, thread.id, thread.is_pinned, workspaceId])

  const handleTogglePinInProject = useCallback(async () => {
    if (!beginAction('pin-in-project')) return
    void Haptics.selectionAsync()
    try {
      await setThreadPinnedInProject(
        workspaceId,
        thread.id,
        !thread.is_pinned_in_project,
      )
      onClose()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to update pin')
    } finally {
      finishAction('pin-in-project')
    }
  }, [
    beginAction,
    finishAction,
    onClose,
    setThreadPinnedInProject,
    thread.id,
    thread.is_pinned_in_project,
    workspaceId,
  ])

  // Unread is `last_agent_activity_seq > last_read_seq`, so a thread the agent
  // never replied in cannot be made unread — hide the row instead of offering
  // an action that would do nothing.
  const canMarkUnread =
    !thread.attention.unread && thread.attention.last_agent_activity_seq > 0

  const handleMarkUnread = useCallback(async () => {
    if (!beginAction('unread')) return
    void Haptics.selectionAsync()
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
      finishAction('unread')
    }
  }, [
    beginAction,
    finishAction,
    markThreadUnread,
    onClose,
    thread.attention.last_agent_activity_seq,
    thread.id,
    workspaceId,
  ])

  const handleArchive = useCallback(() => {
    triggerThreadArchiveHaptic()
    onClose()
    void archiveThread(workspaceId, thread.id).catch(() => {})
  }, [archiveThread, onClose, thread.id, workspaceId])

  const handleUnarchive = useCallback(() => {
    triggerThreadArchiveHaptic()
    onClose()
    void unarchiveThread(workspaceId, thread.id).catch(() => {})
  }, [onClose, thread.id, unarchiveThread, workspaceId])

  const handleRename = useCallback(async () => {
    const nextTitle = renameValue.trim()
    if (!nextTitle) {
      setActionError('Title cannot be empty')
      return
    }

    if (!beginAction('rename')) return
    try {
      await renameThread(workspaceId, thread.id, nextTitle)
      onClose()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to rename thread')
    } finally {
      finishAction('rename')
    }
  }, [beginAction, finishAction, onClose, renameThread, renameValue, thread.id, workspaceId])

  const handleSuggestTitle = useCallback(async () => {
    if (!beginAction('suggest')) return
    void Haptics.selectionAsync()
    try {
      const title = await suggestThreadTitle(workspaceId, thread.id)
      setRenameValue(title)
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Couldn't generate a title",
      )
    } finally {
      finishAction('suggest')
    }
  }, [beginAction, finishAction, suggestThreadTitle, thread.id, workspaceId])

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
        {mode === 'rename' ? 'Rename task' : 'Task options'}
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
            editable={pendingAction === null}
            style={styles.renameInput}
          />
          <Pressable
            style={styles.suggestRow}
            accessibilityRole="button"
            accessibilityLabel="Suggest title"
            onPress={() => void handleSuggestTitle()}
            disabled={pendingAction !== null}
          >
            <Sparkles size={theme.iconSize.sm} color={theme.colors.accent.default} />
            <Text variant="caption" color="secondary">
              {pendingAction === 'suggest' ? 'Suggesting…' : 'Suggest title'}
            </Text>
          </Pressable>
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
              disabled={pendingAction !== null}
            />
            <Button
              label="Save"
              onPress={() => void handleRename()}
              loading={pendingAction === 'rename'}
              disabled={!renameValue.trim() || pendingAction !== null}
            />
          </View>
        </>
      ) : (
        <>
          <SheetGroup>
            <SheetRow
              label={thread.is_pinned ? 'Unpin' : 'Pin'}
              accessibilityLabel={thread.is_pinned ? 'Unpin thread' : 'Pin thread'}
              icon={(color) => <Pin size={theme.iconSize.sm} color={color} />}
              onPress={() => void handleTogglePin()}
              disabled={pendingAction !== null}
            />
            {canPinInProject ? (
              <SheetRow
                label={thread.is_pinned_in_project ? 'Unpin from project' : 'Pin in project'}
                icon={(color) => <Pin size={theme.iconSize.sm} color={color} />}
                onPress={() => void handleTogglePinInProject()}
                disabled={pendingAction !== null}
              />
            ) : null}
            {/* The only row that opens something rather than acting on the
                task, so it is the only one that earns a chevron. */}
            <SheetRow
              label="Rename"
              accessibilityLabel="Rename thread"
              icon={(color) => <Pencil size={theme.iconSize.sm} color={color} />}
              navigates
              onPress={startRename}
            />
            {canMarkUnread ? (
              <SheetRow
                label="Mark as unread"
                accessibilityLabel="Mark thread as unread"
                icon={() => <View style={styles.unreadDot} />}
                onPress={() => void handleMarkUnread()}
                disabled={pendingAction !== null}
              />
            ) : null}
            {onMoveToFolder ? (
              <SheetRow
                label="Move to folder…"
                accessibilityLabel="Move to folder"
                icon={(color) => <FolderInput size={theme.iconSize.sm} color={color} />}
                onPress={onMoveToFolder}
                disabled={pendingAction !== null}
              />
            ) : null}
          </SheetGroup>
          <SheetGroup style={styles.secondGroup}>
            <SheetRow
              label={thread.is_archived ? 'Unarchive' : 'Archive'}
              accessibilityLabel={thread.is_archived ? 'Unarchive thread' : 'Archive thread'}
              tone="info"
              icon={(color) =>
                thread.is_archived ? (
                  <ArchiveRestore size={theme.iconSize.sm} color={color} />
                ) : (
                  <Archive size={theme.iconSize.sm} color={color} />
                )
              }
              onPress={thread.is_archived ? handleUnarchive : handleArchive}
            />
          </SheetGroup>
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
    marginBottom: theme.spacing[3],
  },
  secondGroup: {
    marginTop: theme.spacing[3],
  },
  // Sized into the same box the lucide icons occupy so the labels line up.
  unreadDot: {
    width: theme.iconSize.sm,
    height: theme.iconSize.sm,
    alignSelf: 'center',
    borderRadius: theme.iconSize.sm / 2,
    backgroundColor: theme.colors.unread,
    transform: [{ scale: 0.5 }],
  },
  renameInput: {
    marginTop: theme.spacing[2],
  },
  suggestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    minHeight: theme.minTouchTarget,
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
