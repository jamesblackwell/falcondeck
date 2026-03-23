import { memo, useCallback, useMemo, useState } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { FlashList } from '@shopify/flash-list'
import { ChevronDown, ChevronRight, SquarePen } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'

import type { ProjectGroup, ThreadSummary } from '@falcondeck/client-core'

import { Text, Button, EmptyState, Input } from '@/components/ui'
import { SessionListItem } from '@/components/chat'
import { useThreadActions } from '@/hooks/useThreadActions'
import { buildSidebarRows, type SidebarRow } from './sidebarRows'

interface SidebarViewProps {
  groups: ProjectGroup[]
  selectedThreadId: string | null
  onSelectThread: (workspaceId: string, threadId: string) => void
  onNewThread: (workspaceId: string) => void
}

export const SidebarView = memo(function SidebarView({
  groups,
  selectedThreadId,
  onSelectThread,
  onNewThread,
}: SidebarViewProps) {
  const { theme } = useUnistyles()
  const insets = useSafeAreaInsets()
  const { archiveThread, renameThread } = useThreadActions()

  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(() => new Set())
  const [expandedThreadLists, setExpandedThreadLists] = useState<Set<string>>(() => new Set())
  const [optionsTarget, setOptionsTarget] = useState<{
    workspaceId: string
    thread: ThreadSummary
  } | null>(null)
  const [sheetMode, setSheetMode] = useState<'menu' | 'rename'>('menu')
  const [renameValue, setRenameValue] = useState('')
  const [pendingAction, setPendingAction] = useState<'archive' | 'rename' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const rows = useMemo(
    () => buildSidebarRows(groups, collapsedWorkspaces, expandedThreadLists, selectedThreadId),
    [groups, collapsedWorkspaces, expandedThreadLists, selectedThreadId],
  )


  const toggleWorkspaceCollapse = useCallback((workspaceId: string) => {
    setCollapsedWorkspaces((prev) => {
      const next = new Set(prev)
      if (next.has(workspaceId)) {
        next.delete(workspaceId)
      } else {
        next.add(workspaceId)
      }
      return next
    })
  }, [])

  const toggleThreadListExpanded = useCallback((workspaceId: string) => {
    setExpandedThreadLists((prev) => {
      const next = new Set(prev)
      if (next.has(workspaceId)) {
        next.delete(workspaceId)
      } else {
        next.add(workspaceId)
      }
      return next
    })
  }, [])

  const openThreadOptions = useCallback((workspaceId: string, thread: ThreadSummary) => {
    void Haptics.selectionAsync()
    setOptionsTarget({ workspaceId, thread })
    setSheetMode('menu')
    setRenameValue(thread.title)
    setActionError(null)
  }, [])

  const closeThreadOptions = useCallback(() => {
    setOptionsTarget(null)
    setRenameValue('')
    setPendingAction(null)
    setActionError(null)
    setSheetMode('menu')
  }, [])

  const handleArchiveThread = useCallback(async () => {
    if (!optionsTarget) return
    setPendingAction('archive')
    setActionError(null)
    try {
      await archiveThread(optionsTarget.workspaceId, optionsTarget.thread.id)
      closeThreadOptions()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to archive thread')
    } finally {
      setPendingAction(null)
    }
  }, [archiveThread, closeThreadOptions, optionsTarget])

  const handleStartRename = useCallback(() => {
    void Haptics.selectionAsync()
    setSheetMode('rename')
    setActionError(null)
  }, [])

  const handleRenameThread = useCallback(async () => {
    if (!optionsTarget) return
    const nextTitle = renameValue.trim()
    if (!nextTitle) {
      setActionError('Title cannot be empty')
      return
    }

    setPendingAction('rename')
    setActionError(null)
    try {
      await renameThread(optionsTarget.workspaceId, optionsTarget.thread.id, nextTitle)
      closeThreadOptions()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to rename thread')
    } finally {
      setPendingAction(null)
    }
  }, [closeThreadOptions, optionsTarget, renameThread, renameValue])

  const renderRow = useCallback(
    ({ item }: { item: SidebarRow }) => {
      if (item.type === 'workspace') {
        return (
          <Pressable
            style={styles.workspaceHeader}
            onPress={() => toggleWorkspaceCollapse(item.workspaceId)}
          >
            <View style={styles.workspaceLeft}>
              {item.isOpen ? (
                <ChevronDown size={14} color={theme.colors.fg.muted} />
              ) : (
                <ChevronRight size={14} color={theme.colors.fg.muted} />
              )}
              <Text variant="label" color="secondary" weight="medium" numberOfLines={1} style={styles.workspaceName}>
                {item.workspaceName}
              </Text>
            </View>
            <Button
              variant="ghost"
              size="icon"
              onPress={() => onNewThread(item.workspaceId)}
            >
              <SquarePen size={14} color={theme.colors.fg.muted} />
            </Button>
          </Pressable>
        )
      }

      if (item.type === 'overflow') {
        return (
          <Pressable
            style={styles.overflowRow}
            onPress={() => toggleThreadListExpanded(item.workspaceId)}
          >
            <ChevronDown
              size={12}
              color={theme.colors.fg.muted}
              style={item.isExpanded ? styles.chevronFlipped : undefined}
            />
            <Text variant="caption" color="muted">
              {item.isExpanded ? 'Show less' : `${item.hiddenCount} older threads`}
            </Text>
          </Pressable>
        )
      }

      return (
        <SessionListItem
          thread={item.thread}
          workspaceId={item.workspaceId}
          isSelected={selectedThreadId === item.thread.id}
          onSelectThread={onSelectThread}
          onOpenThreadOptions={openThreadOptions}
        />
      )
    },
    [onNewThread, onSelectThread, openThreadOptions, selectedThreadId, theme.colors.fg.muted, toggleWorkspaceCollapse, toggleThreadListExpanded],
  )

  const renderSheetContent = () => {
    if (!optionsTarget) return null
    const isRenaming = sheetMode === 'rename'
    return (
      <View style={styles.sheet}>
        <View style={styles.sheetHandle} />
        <Text variant="label" color="primary" weight="semibold" style={styles.sheetTitle}>
          {isRenaming ? 'Rename thread' : 'Thread options'}
        </Text>
        <Text variant="caption" color="muted" numberOfLines={1} style={styles.sheetSubtitle}>
          {optionsTarget.thread.title || 'New thread'}
        </Text>

        {isRenaming ? (
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
            <View style={styles.sheetActions}>
              <Button
                variant="ghost"
                label="Cancel"
                onPress={closeThreadOptions}
                disabled={pendingAction === 'rename'}
              />
              <Button
                label="Save"
                onPress={() => void handleRenameThread()}
                loading={pendingAction === 'rename'}
                disabled={!renameValue.trim()}
              />
            </View>
          </>
        ) : (
          <>
            <Pressable style={styles.sheetItem} onPress={handleStartRename}>
              <Text variant="label" color="primary">
                Rename
              </Text>
              <ChevronRight size={14} color={theme.colors.fg.muted} />
            </Pressable>
            <Pressable
              style={[styles.sheetItem, styles.dangerRow]}
              onPress={() => void handleArchiveThread()}
              disabled={pendingAction === 'archive'}
            >
              <Text variant="label" color="danger">
                Archive
              </Text>
              <ChevronRight size={14} color={theme.colors.danger.default} />
            </Pressable>
            {actionError ? (
              <Text variant="caption" color="danger" style={styles.errorText}>
                {actionError}
              </Text>
            ) : null}
          </>
        )}
      </View>
    )
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.list}>
        {rows.length === 0 ? (
          <EmptyState title="No projects" description="Connect from your desktop to get started" />
        ) : (
          <FlashList
            data={rows}
            renderItem={renderRow}
            keyExtractor={(item) => item.key}
            getItemType={(item) => item.type}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.listContent}
          />
        )}
      </View>

      {optionsTarget ? (
        <Modal transparent animationType="fade" onRequestClose={closeThreadOptions}>
          <KeyboardAvoidingView
            style={styles.sheetContainer}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <Pressable style={styles.sheetBackdrop} onPress={closeThreadOptions} />
            {renderSheetContent()}
          </KeyboardAvoidingView>
        </Modal>
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface[1],
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingVertical: theme.spacing[3],
  },
  workspaceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    marginTop: theme.spacing[2],
  },
  workspaceLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
  },
  workspaceName: {
    flex: 1,
  },
  overflowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[1.5],
    marginLeft: theme.spacing[3],
  },
  chevronFlipped: {
    transform: [{ rotate: '180deg' }],
  },
  sheetContainer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  sheet: {
    backgroundColor: theme.colors.surface[1],
    borderTopLeftRadius: theme.radius['2xl'],
    borderTopRightRadius: theme.radius['2xl'],
    paddingBottom: theme.spacing[8],
    paddingHorizontal: theme.spacing[4],
  },
  sheetHandle: {
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.border.emphasis,
    alignSelf: 'center',
    marginTop: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  sheetTitle: {
    paddingHorizontal: theme.spacing[2],
  },
  sheetSubtitle: {
    paddingHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  sheetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface[2],
    marginBottom: theme.spacing[2],
  },
  dangerRow: {
    backgroundColor: theme.colors.danger.subtle,
  },
  renameInput: {
    marginTop: theme.spacing[2],
  },
  sheetActions: {
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
