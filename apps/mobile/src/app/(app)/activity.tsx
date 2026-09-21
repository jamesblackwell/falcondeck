import { useCallback, useMemo, useState } from 'react'
import { Pressable, View } from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import {
  buildProjectGroups,
  collectActivityEntries,
  collectRecentEntries,
  type ActivitySection,
  type RecentEntry,
} from '@falcondeck/client-core'
import { ActivityDiamond, Button, EmptyState, SyncBanner, Text } from '@/components/ui'
import { useSessionStore, useThrottledSnapshot } from '@/store'
import { useSessionSyncStatus } from '@/hooks/useSessionSyncStatus'
import { useRelativeTimeTick } from '@/hooks/useRelativeTimeTick'
import { loadSyncThreadPage } from '@/hooks/sync-index'
import { formatRelativeTime } from '@/components/chat/sessionListItem.utils'
import { triggerThreadSelectionHaptic } from '@/lib/haptics'

type Section = ActivitySection | 'recent'
type Row =
  | { key: string; kind: 'heading'; section: Section; count: number }
  | { key: string; kind: 'task'; section: Section; entry: RecentEntry; preview: string | null }
const labels: Record<Section, string> = {
  blocked: 'Needs input', failed: 'Failed', ready: 'Ready to review', running: 'Running', recent: 'Recent',
}
const sections: Section[] = ['blocked', 'failed', 'ready', 'running', 'recent']
const keyExtractor = (row: Row) => row.key
const getItemType = (row: Row) => row.kind

export default function ActivityScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { theme } = useUnistyles()
  const snapshot = useThrottledSnapshot(250)
  const syncStatus = useSessionSyncStatus()
  const nowTick = useRelativeTimeTick()
  const [loadingMore, setLoadingMore] = useState(false)
  const groups = useMemo(() => buildProjectGroups(
    snapshot?.workspaces ?? [], snapshot?.threads ?? [], snapshot?.preferences.workspace_order,
  ), [snapshot?.workspaces, snapshot?.threads, snapshot?.preferences.workspace_order])
  const rows = useMemo(() => {
    const requests = snapshot?.interactive_requests ?? []
    const active = collectActivityEntries(groups, requests)
    const recent = collectRecentEntries(groups, requests, { nowMs: nowTick * 60_000 })
    const result: Row[] = []
    for (const section of sections) {
      const entries = section === 'recent' ? recent : active.filter(entry => entry.section === section)
      if (!entries.length) continue
      result.push({ key: section, kind: 'heading', section, count: entries.length })
      for (const entry of entries) {
        const thread = entry.thread
        const preview = section === 'failed' ? thread.last_error ?? 'The run failed'
          : section === 'blocked' ? 'Open this task to review its request and respond.'
          : section === 'running' ? thread.last_tool ?? thread.last_message_preview ?? 'Working…'
          : thread.last_message_preview
        result.push({ key: `${entry.workspaceId}:${thread.id}`, kind: 'task', section, entry, preview })
      }
    }
    return result
  }, [groups, snapshot?.interactive_requests, nowTick])
  // The initial sync is bounded. Expose paging even when its first 50 tasks
  // contain no activity, rather than implying the entire queue is empty.
  const remainingWorkspaces = useMemo(() => {
    const index = snapshot?.sync_index
    if (!index) return []
    return (snapshot?.workspaces ?? []).filter(workspace =>
      (index.counts[workspace.id]?.total ?? 0) > 0 && index.cursors[`${workspace.id}:last_updated`] !== null,
    )
  }, [snapshot?.sync_index, snapshot?.workspaces])
  const loadMore = useCallback(async () => {
    const token = useSessionStore.getState().snapshot?.sync_index?.token
    setLoadingMore(true)
    try {
      for (const workspace of remainingWorkspaces) {
        if (useSessionStore.getState().snapshot?.sync_index?.token !== token) break
        await loadSyncThreadPage(workspace.id, 'last_updated', 50)
      }
    } finally {
      setLoadingMore(false)
    }
  }, [remainingWorkspaces])
  const openTask = useCallback((entry: RecentEntry) => {
    triggerThreadSelectionHaptic()
    useSessionStore.getState().selectThread(entry.workspaceId, entry.thread.id)
    router.navigate('/(app)')
  }, [router])
  const renderItem = useCallback(({ item }: { item: Row }) => {
    if (item.kind === 'heading') return (
      <View style={styles.section}>
        <Text variant="microlabel">{labels[item.section]}</Text>
        <Text variant="meta">{item.count}</Text>
      </View>
    )
    const tone = item.section === 'blocked' ? 'warning' : item.section === 'failed' ? 'danger' : 'muted'
    return (
      <Pressable style={({ pressed }) => [styles.task, pressed ? styles.pressed : null]}
        accessibilityRole="button" accessibilityLabel={`${item.entry.thread.title || 'New task'}, ${item.entry.projectLabel}, ${labels[item.section]}`}
        accessibilityHint="Opens the conversation" onPress={() => openTask(item.entry)}>
        <View style={styles.taskHeader}>
          {item.section === 'running' ? <ActivityDiamond size={14} color={theme.colors.accent.default} /> : null}
          <Text variant="label" numberOfLines={2} style={styles.title}>{item.entry.thread.title || 'New task'}</Text>
          <Text variant="meta">{formatRelativeTime(item.entry.thread.updated_at)}</Text>
        </View>
        <Text variant="meta" color={tone}>{item.entry.projectLabel}</Text>
        {item.preview ? <Text variant="supporting" numberOfLines={3}>{item.preview}</Text> : null}
      </Pressable>
    )
  }, [openTask, theme.colors.accent.default])
  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Button variant="ghost" size="icon" accessibilityLabel="Close activity" onPress={() => router.navigate('/(app)')}>
          <ChevronLeft size={theme.iconSize.lg} color={theme.colors.fg.primary} />
        </Button>
        <View style={styles.title}>
          <Text variant="heading" size="lg">Activity</Text>
          <Text variant="meta">{remainingWorkspaces.length ? 'Activity from loaded tasks' : 'Across all projects'}</Text>
        </View>
      </View>
      <SyncBanner status={syncStatus} />
      <FlashList data={rows} renderItem={renderItem} keyExtractor={keyExtractor} getItemType={getItemType}
        extraData={nowTick} maintainVisibleContentPosition={{ disabled: true }}
        contentContainerStyle={{ paddingHorizontal: theme.spacing[4], paddingBottom: insets.bottom + theme.spacing[6] }}
        ListEmptyComponent={syncStatus.isBusy && syncStatus.stage !== 'offline' ? null : (
          <EmptyState title={remainingWorkspaces.length ? 'No activity in loaded tasks' : 'All caught up'}
            description={remainingWorkspaces.length ? 'Load more tasks to check the rest of your projects.' : 'Tasks needing input, results to review, and running work appear here.'} />
        )}
        ListFooterComponent={remainingWorkspaces.length ? (
          <Button variant="ghost" label="Load more tasks" loading={loadingMore} disabled={loadingMore || syncStatus.isBusy} onPress={() => void loadMore()} />
        ) : null}
      />
    </View>
  )
}
const styles = StyleSheet.create(theme => ({
  container: { flex: 1, backgroundColor: theme.colors.surface[1] },
  header: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2], padding: theme.spacing[2], borderBottomWidth: 1, borderBottomColor: theme.colors.border.subtle },
  title: { flex: 1 },
  section: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: theme.spacing[6], paddingBottom: theme.spacing[2] },
  task: { minHeight: theme.minTouchTarget, padding: theme.spacing[3], gap: theme.spacing[2], marginBottom: theme.spacing[2], backgroundColor: theme.colors.surface[2], borderRadius: theme.radius.lg, borderWidth: 1, borderColor: theme.colors.border.subtle },
  pressed: { backgroundColor: theme.colors.surface[3] },
  taskHeader: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] },
}))
