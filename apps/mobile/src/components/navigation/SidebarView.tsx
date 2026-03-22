import { memo, useCallback, useMemo, useState } from 'react'
import { Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { FlashList } from '@shopify/flash-list'
import { ChevronDown, ChevronRight, Settings, SquarePen } from 'lucide-react-native'
import { useRouter } from 'expo-router'

import type { ProjectGroup } from '@falcondeck/client-core'

import { Text, Button, EmptyState } from '@/components/ui'
import { SessionListItem } from '@/components/chat'
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
  const router = useRouter()

  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(() => new Set())
  const [expandedThreadLists, setExpandedThreadLists] = useState<Set<string>>(() => new Set())

  const rows = useMemo(
    () => buildSidebarRows(groups, collapsedWorkspaces, expandedThreadLists, selectedThreadId),
    [groups, collapsedWorkspaces, expandedThreadLists, selectedThreadId],
  )

  const handleOpenSettings = useCallback(() => {
    router.push('/(app)/settings')
  }, [router])

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
              <Text variant="label" color="secondary" size="sm" weight="medium" numberOfLines={1} style={styles.workspaceName}>
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
            <Text variant="caption" color="muted" size="xs">
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
        />
      )
    },
    [onNewThread, onSelectThread, selectedThreadId, theme.colors.fg.muted, toggleWorkspaceCollapse, toggleThreadListExpanded],
  )

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text variant="heading" size="lg">
            FalconDeck
          </Text>
        </View>
        <Button
          variant="ghost"
          size="icon"
          onPress={handleOpenSettings}
        >
          <Settings size={20} color={theme.colors.fg.muted} />
        </Button>
      </View>

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
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface[1],
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.subtle,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[3],
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
}))
