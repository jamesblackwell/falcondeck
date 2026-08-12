import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { FlashList } from '@shopify/flash-list'
import { ChevronDown, ChevronRight, Settings, SquarePen, X } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'

import type { ProjectGroup, ThreadSummary, ThreadTag } from '@falcondeck/client-core'

import { Text, Button, EmptyState, SyncBanner } from '@/components/ui'
import { SessionListItem } from '@/components/chat'
import { useCollapsible } from '@/components/chat/useCollapsible'
import { useSessionSyncStatus } from '@/hooks/useSessionSyncStatus'
import { buildSidebarRows, SHOW_MORE_STEP, type SidebarRow } from './sidebarRows'
import { ThreadOptionsSheet } from './ThreadOptionsSheet'

interface SidebarViewProps {
  groups: ProjectGroup[]
  selectedThreadId: string | null
  onSelectThread: (workspaceId: string, threadId: string) => void
  onNewThread: (workspaceId: string) => void
  onOpenSettings?: () => void
  /** Dismisses the drawer; the full-width sidebar leaves no scrim to tap. */
  onClose?: () => void
  threadTagsById?: Record<string, ThreadTag[]>
}

// Rotating one chevron rather than swapping two icons, so the open/close
// toggle reads as a single continuous motion.
const CHEVRON_TIMING = { duration: 150, easing: Easing.out(Easing.cubic) } as const

const WorkspaceChevron = memo(function WorkspaceChevron({
  workspaceId,
  isOpen,
  size,
  color,
}: {
  workspaceId: string
  isOpen: boolean
  size: number
  color: string
}) {
  const progress = useSharedValue(isOpen ? 1 : 0)
  const renderedWorkspaceId = useRef(workspaceId)

  useEffect(() => {
    const target = isOpen ? 1 : 0
    // FlashList recycles rows, so this view can land on a different workspace
    // mid-scroll: snap there instead of spinning through a toggle nobody made.
    if (renderedWorkspaceId.current !== workspaceId) {
      renderedWorkspaceId.current = workspaceId
      progress.value = target
      return
    }
    progress.value = withTiming(target, CHEVRON_TIMING)
  }, [isOpen, progress, workspaceId])

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${progress.value * 90}deg` }],
  }))

  return (
    <Animated.View style={chevronStyle}>
      <ChevronRight size={size} color={color} />
    </Animated.View>
  )
})

// Collapsed projects keep their thread rows in the list data so the same cells
// can animate shut — height runs to zero while everything below slides up,
// matching the iOS accordion feel. `useCollapsible` already handles FlashList
// recycling (snap, don't animate, when the cell lands on a different row).
const CollapsibleRow = memo(function CollapsibleRow({
  rowKey,
  isCollapsed,
  children,
}: {
  rowKey: string
  isCollapsed: boolean
  children: ReactNode
}) {
  const { bodyStyle, onContentLayout } = useCollapsible(!isCollapsed, rowKey)

  return (
    <Animated.View
      style={bodyStyle}
      pointerEvents={isCollapsed ? 'none' : 'auto'}
      accessibilityElementsHidden={isCollapsed}
      importantForAccessibility={isCollapsed ? 'no-hide-descendants' : 'auto'}
    >
      <View onLayout={onContentLayout}>{children}</View>
    </Animated.View>
  )
})

export const SidebarView = memo(function SidebarView({
  groups,
  selectedThreadId,
  onSelectThread,
  onNewThread,
  onOpenSettings,
  onClose,
  threadTagsById,
}: SidebarViewProps) {
  const { theme } = useUnistyles()
  const insets = useSafeAreaInsets()
  // The sidebar is where "New thread" lives, so it is where the boot-time wait
  // has to be visible: without this the button looks broken for ~10s.
  const syncStatus = useSessionSyncStatus()

  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(() => new Set())
  const [visibleThreadCounts, setVisibleThreadCounts] = useState<Map<string, number>>(
    () => new Map(),
  )
  const [optionsTarget, setOptionsTarget] = useState<{
    workspaceId: string
    thread: ThreadSummary
  } | null>(null)

  const rows = useMemo(
    () => buildSidebarRows(groups, collapsedWorkspaces, visibleThreadCounts, selectedThreadId),
    [groups, collapsedWorkspaces, visibleThreadCounts, selectedThreadId],
  )

  // The drawer runs to the bottom of the screen, so the last thread would sit
  // under the home indicator without this.
  const listContentStyle = useMemo(
    () => ({
      paddingTop: theme.spacing[3],
      paddingBottom: theme.spacing[3] + insets.bottom,
    }),
    [insets.bottom, theme.spacing],
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

  const handleOverflowPress = useCallback(
    (workspaceId: string, visibleCount: number, isExpanded: boolean) => {
      setVisibleThreadCounts((prev) => {
        const next = new Map(prev)
        if (isExpanded) {
          next.delete(workspaceId)
        } else {
          next.set(workspaceId, visibleCount + SHOW_MORE_STEP)
        }
        return next
      })
    },
    [],
  )

  const openThreadOptions = useCallback((workspaceId: string, thread: ThreadSummary) => {
    void Haptics.selectionAsync()
    setOptionsTarget({ workspaceId, thread })
  }, [])

  const closeThreadOptions = useCallback(() => {
    setOptionsTarget(null)
  }, [])

  const renderRow = useCallback(
    ({ item }: { item: SidebarRow }) => {
      if (item.type === 'section') {
        return (
          <Text variant="caption" color="muted" weight="medium" style={styles.sectionHeading}>
            {item.title.toUpperCase()}
          </Text>
        )
      }

      if (item.type === 'workspace') {
        // Two sibling controls, not a button inside a button: nesting them made
        // VoiceOver read the row as one element and swallowed "new thread".
        return (
          <View style={styles.workspaceHeader}>
            <Pressable
              style={styles.workspaceLeft}
              onPress={() => toggleWorkspaceCollapse(item.workspaceId)}
              accessibilityRole="button"
              accessibilityLabel={item.workspaceName}
              accessibilityHint={item.isOpen ? 'Collapses this project' : 'Expands this project'}
              accessibilityState={{ expanded: item.isOpen }}
            >
              <WorkspaceChevron
                workspaceId={item.workspaceId}
                isOpen={item.isOpen}
                size={theme.iconSize.xs}
                color={theme.colors.fg.muted}
              />
              <Text
                variant="label"
                color="secondary"
                weight="medium"
                numberOfLines={1}
                style={styles.workspaceName}
              >
                {item.workspaceName}
              </Text>
            </Pressable>
            <Button
              variant="ghost"
              size="icon"
              accessibilityLabel={`New thread in ${item.workspaceName}`}
              onPress={() => onNewThread(item.workspaceId)}
            >
              <SquarePen size={theme.iconSize.xs} color={theme.colors.fg.muted} />
            </Button>
          </View>
        )
      }

      if (item.type === 'overflow') {
        return (
          <CollapsibleRow rowKey={item.key} isCollapsed={item.isCollapsed}>
            <Pressable
              style={styles.overflowRow}
              onPress={() =>
                handleOverflowPress(item.workspaceId, item.visibleCount, item.isExpanded)
              }
              accessibilityRole="button"
              accessibilityState={{ expanded: item.isExpanded }}
            >
              <ChevronDown
                size={12}
                color={theme.colors.fg.muted}
                style={item.isExpanded ? styles.chevronFlipped : undefined}
              />
              <Text variant="caption" color="muted">
                {item.isExpanded ? 'Show less' : 'Show more'}
              </Text>
            </Pressable>
          </CollapsibleRow>
        )
      }

      return (
        <CollapsibleRow rowKey={item.key} isCollapsed={item.isCollapsed}>
          <SessionListItem
            thread={item.thread}
            workspaceId={item.workspaceId}
            isSelected={selectedThreadId === item.thread.id}
            onSelectThread={onSelectThread}
            onOpenThreadOptions={openThreadOptions}
            tags={threadTagsById?.[item.thread.id]}
          />
        </CollapsibleRow>
      )
    },
    [
      onNewThread,
      onSelectThread,
      openThreadOptions,
      selectedThreadId,
      theme.colors.fg.muted,
      theme.iconSize.xs,
      toggleWorkspaceCollapse,
      handleOverflowPress,
      threadTagsById,
    ],
  )

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {onClose ? (
        <View style={styles.header}>
          <Text variant="label" color="primary" weight="semibold">
            Threads
          </Text>
          <Pressable
            style={({ pressed }) => [styles.closeButton, pressed ? styles.closeButtonPressed : undefined]}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close sidebar"
            hitSlop={8}
          >
            <X size={theme.iconSize.md} color={theme.colors.fg.secondary} />
          </Pressable>
        </View>
      ) : null}

      <SyncBanner status={syncStatus} />

      <View style={styles.list}>
        {rows.length === 0 ? (
          // 'offline' is a dead end rather than a wait, so it keeps the
          // regular empty state; the banner above already explains it.
          syncStatus.isBusy && syncStatus.stage !== 'offline' ? (
            <EmptyState title="Loading your projects…" description={syncStatus.detail} />
          ) : (
            <EmptyState title="No projects" description="Connect from your desktop to get started" />
          )
        ) : (
          <FlashList
            data={rows}
            renderItem={renderRow}
            keyExtractor={(item) => item.key}
            getItemType={(item) => item.type}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={listContentStyle}
          />
        )}
      </View>

      {onOpenSettings ? (
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, theme.spacing[3]) }]}>
          <Pressable
            style={({ pressed }) => [styles.settingsRow, pressed ? styles.settingsRowPressed : undefined]}
            onPress={onOpenSettings}
            accessibilityRole="button"
            accessibilityLabel="Settings"
            accessibilityHint="Opens mobile settings"
          >
            <Settings size={theme.iconSize.sm} color={theme.colors.fg.secondary} />
            <Text variant="label" color="secondary" weight="medium">Settings</Text>
          </Pressable>
        </View>
      ) : null}

      {optionsTarget ? (
        <ThreadOptionsSheet
          workspaceId={optionsTarget.workspaceId}
          thread={optionsTarget.thread}
          onClose={closeThreadOptions}
        />
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: theme.minTouchTarget,
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[2],
    paddingTop: theme.spacing[1],
  },
  closeButton: {
    width: theme.minTouchTarget,
    height: theme.minTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.full,
  },
  closeButtonPressed: { backgroundColor: theme.colors.surface[2] },
  footer: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border.subtle,
    backgroundColor: theme.colors.surface[1],
  },
  settingsRow: {
    minHeight: theme.minTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.radius.lg,
  },
  settingsRowPressed: { backgroundColor: theme.colors.surface[2] },
  workspaceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing[3],
    marginTop: theme.spacing[2],
  },
  sectionHeading: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    letterSpacing: 0.8,
  },
  workspaceLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    // The row is the whole tap target for collapsing, so it carries the
    // minimum height rather than the header wrapper around it.
    minHeight: theme.minTouchTarget,
  },
  workspaceName: {
    flex: 1,
  },
  overflowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[1.5],
    minHeight: theme.minTouchTarget,
    paddingHorizontal: theme.spacing[4],
    marginLeft: theme.spacing[3],
  },
  chevronFlipped: {
    transform: [{ rotate: '180deg' }],
  },
}))
