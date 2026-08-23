import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Pressable, View } from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { useFocusEffect, useRouter } from 'expo-router'
import { CalendarClock, ChevronLeft, Plus } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { useShallow } from 'zustand/react/shallow'

import {
  isDaemonRpcReady,
  type Automation,
  type AutomationRun,
} from '@falcondeck/client-core'

import {
  AutomationEditorSheet,
  AutomationHistorySheet,
  AutomationRow,
  type AutomationEditorSubmit,
} from '@/components/automations'
import { ActivityDiamond, Button, EmptyState, ErrorBanner, OptionSheet, Text } from '@/components/ui'
import { subscribeToControlStateChanges } from '@/features/automations/control-events'
import { AutomationControlError, useAutomationStore, useRelayStore, useSessionStore } from '@/store'

type EditorTarget =
  | { kind: 'create'; workspacePath: string }
  | { kind: 'edit'; automation: Automation }

const keyExtractor = (automation: Automation) => automation.id

export default function AutomationsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { theme } = useUnistyles()
  const sessionId = useRelayStore((state) => state.sessionId)
  const machinePresence = useRelayStore((state) => state.machinePresence)
  const selectedWorkspacePath = useSessionStore((state) =>
    state.snapshot?.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId)?.path ?? '',
  )
  const {
    automations,
    settings,
    runsByAutomation,
    hydrated,
    isLoading,
    isRefreshing,
    error,
    lastSyncedAt,
  } = useAutomationStore(useShallow((state) => ({
    automations: state.automations,
    settings: state.settings,
    runsByAutomation: state.runsByAutomation,
    hydrated: state.hydrated,
    isLoading: state.isLoading,
    isRefreshing: state.isRefreshing,
    error: state.error,
    lastSyncedAt: state.lastSyncedAt,
  })))
  const [actionTarget, setActionTarget] = useState<Automation | null>(null)
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null)
  const [historyTarget, setHistoryTarget] = useState<Automation | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const daemonReady = isDaemonRpcReady(machinePresence)

  useFocusEffect(useCallback(() => {
    if (!sessionId) return
    const store = useAutomationStore.getState()
    store.hydrate(sessionId)
    if (daemonReady) void store.refresh({ silent: store.automations.length > 0 }).catch(() => {})
  }, [daemonReady, sessionId]))

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    return subscribeToControlStateChanges((change) => {
      if (!change.domains.some((domain) => domain === 'automations' || domain === 'runs')) return
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        if (isDaemonRpcReady(useRelayStore.getState().machinePresence)) {
          void useAutomationStore.getState().refresh({ silent: true }).catch(() => {})
        }
      }, 250)
    })
  }, [])

  const openEditor = useCallback(async (automation: Automation) => {
    setActionTarget(null)
    setBusyId(automation.id)
    setActionError(null)
    try {
      const current = await useAutomationStore.getState().read(automation.id)
      if (!current) throw new Error('This automation no longer exists.')
      setEditorTarget({ kind: 'edit', automation: current })
    } catch (readError) {
      setActionError(readError instanceof Error ? readError.message : String(readError))
      if (!daemonReady) {
        // The cached definition remains useful for reading, but saving a stale
        // revision while offline would only produce a confusing timeout.
        setActionError('Desktop is offline. Reconnect before editing this cached automation.')
      }
    } finally {
      setBusyId(null)
    }
  }, [daemonReady])

  const openHistory = useCallback((automation: Automation) => {
    setActionTarget(null)
    setHistoryTarget(automation)
    setHistoryLoading(true)
    void useAutomationStore.getState().loadRuns(automation.id)
      .catch((loadError) => setActionError(loadError instanceof Error ? loadError.message : String(loadError)))
      .finally(() => setHistoryLoading(false))
  }, [])

  const runOperation = useCallback(async (
    operation: string,
    automation: Automation,
    expectedRevision?: number,
  ) => {
    setActionTarget(null)
    setBusyId(automation.id)
    setActionError(null)
    try {
      await useAutomationStore.getState().execute({
        operation,
        arguments: { automation_id: automation.id },
        expected_revision: expectedRevision,
      })
    } catch (operationError) {
      const detail = operationError instanceof AutomationControlError ? operationError.detail : null
      setActionError(
        detail?.code === 'revision_conflict'
          ? detail.suggested_action ?? 'This automation changed elsewhere. Refresh and try again.'
          : operationError instanceof Error ? operationError.message : String(operationError),
      )
      if (detail?.code === 'revision_conflict') {
        void useAutomationStore.getState().refresh({ silent: true }).catch(() => {})
      }
    } finally {
      setBusyId(null)
    }
  }, [])

  const deleteAutomation = useCallback((automation: Automation) => {
    setActionTarget(null)
    Alert.alert(
      'Delete automation?',
      `“${automation.name}” will stop running. Its agent threads are kept.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => void runOperation('automation.delete', automation, automation.revision),
        },
      ],
    )
  }, [runOperation])

  const submitEditor = useCallback(async (submission: AutomationEditorSubmit) => {
    setActionError(null)
    try {
      await useAutomationStore.getState().execute({
        operation: submission.operation,
        arguments: submission.arguments,
        expected_revision: submission.expectedRevision,
      })
      setEditorTarget(null)
    } catch (submitError) {
      const detail = submitError instanceof AutomationControlError ? submitError.detail : null
      setActionError(detail?.suggested_action ?? (submitError instanceof Error ? submitError.message : String(submitError)))
      throw submitError
    }
  }, [])

  const actionItems = useMemo(() => actionTarget ? [
    {
      value: 'toggle',
      label: actionTarget.state === 'enabled' ? 'Pause' : 'Resume',
      description: actionTarget.state === 'enabled' ? 'Prevent future scheduled runs' : 'Enable future scheduled runs',
      disabled: !daemonReady,
      disabledReason: 'Reconnect to the desktop first',
    },
    { value: 'run', label: 'Run now', description: 'Start a run without changing the schedule', disabled: !daemonReady, disabledReason: 'Reconnect to the desktop first' },
    { value: 'history', label: 'Run history', description: 'Show recent outcomes and agent threads' },
    { value: 'edit', label: 'Edit', description: 'Change schedule, task, or execution settings', disabled: !daemonReady, disabledReason: 'Reconnect to the desktop first' },
    { value: 'delete', label: 'Delete', description: 'Remove the definition but keep its threads', destructive: true, disabled: !daemonReady, disabledReason: 'Reconnect to the desktop first' },
  ] : [], [actionTarget, daemonReady])

  const handleAction = useCallback((action: string) => {
    const automation = actionTarget
    if (!automation) return
    if (action === 'toggle') {
      void runOperation(
        automation.state === 'enabled' ? 'automation.pause' : 'automation.resume',
        automation,
        automation.revision,
      )
    } else if (action === 'run') {
      void runOperation('automation.run_now', automation)
    } else if (action === 'history') {
      openHistory(automation)
    } else if (action === 'edit') {
      void openEditor(automation)
    } else if (action === 'delete') {
      deleteAutomation(automation)
    }
  }, [actionTarget, deleteAutomation, openEditor, openHistory, runOperation])

  const openRun = useCallback((run: AutomationRun) => {
    if (!run.runtime_workspace_id || !run.thread_id) return
    useSessionStore.getState().selectThread(run.runtime_workspace_id, run.thread_id)
    setHistoryTarget(null)
    router.navigate('/(app)')
  }, [router])

  const renderItem = useCallback(({ item }: { item: Automation }) => (
    <AutomationRow
      automation={item}
      busy={busyId === item.id}
      onEdit={daemonReady ? openEditor : setActionTarget}
      onOpenActions={setActionTarget}
    />
  ), [busyId, daemonReady, openEditor])

  const cachedStatus = lastSyncedAt
    ? `${daemonReady ? 'Synced' : 'Cached'} ${new Date(lastSyncedAt).toLocaleString()}`
    : daemonReady ? 'Connecting to automations…' : 'Desktop offline'

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable
          style={({ pressed }) => [styles.headerButton, pressed ? styles.headerButtonPressed : null]}
          onPress={() => router.navigate('/(app)')}
          accessibilityRole="button"
          accessibilityLabel="Close automations"
        >
          <ChevronLeft size={theme.iconSize.lg} color={theme.colors.fg.primary} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text variant="heading" size="lg">Automations</Text>
          <Text variant="meta" color="muted" numberOfLines={1}>{cachedStatus}</Text>
        </View>
        <Button
          size="icon"
          variant="ghost"
          onPress={() => setEditorTarget({ kind: 'create', workspacePath: selectedWorkspacePath })}
          disabled={!daemonReady}
          accessibilityLabel="New automation"
        >
          <Plus size={theme.iconSize.md} color={theme.colors.fg.primary} />
        </Button>
      </View>

      <ErrorBanner message={actionError ?? error} onDismiss={() => {
        setActionError(null)
        useAutomationStore.getState().clearError()
      }} />

      {!daemonReady && automations.length > 0 ? (
        <View style={styles.cacheBanner}>
          <Text variant="caption" color="warning">
            Showing cached automations. Reconnect to run or edit them.
          </Text>
        </View>
      ) : null}

      {!hydrated || (isLoading && automations.length === 0) ? (
        <View style={styles.center}>
          <ActivityDiamond color={theme.colors.accent.default} />
          <Text variant="supporting" color="muted">Loading automations…</Text>
        </View>
      ) : automations.length === 0 ? (
        <View style={styles.center}>
          <EmptyState
            title="No automations"
            description={daemonReady
              ? 'Create a scheduled agent instruction here or ask an agent to make one.'
              : 'Reconnect to your desktop to load automations.'}
            icon={<CalendarClock size={theme.iconSize.lg} color={theme.colors.fg.muted} />}
          />
          {daemonReady ? (
            <Button
              label="New automation"
              onPress={() => setEditorTarget({ kind: 'create', workspacePath: selectedWorkspacePath })}
            />
          ) : null}
        </View>
      ) : (
        <FlashList
          data={automations}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          refreshing={isRefreshing && automations.length > 0}
          onRefresh={daemonReady
            ? () => void useAutomationStore.getState().refresh().catch(() => {})
            : undefined}
          contentContainerStyle={{ paddingBottom: insets.bottom + theme.spacing[4] }}
          showsVerticalScrollIndicator={false}
        />
      )}

      {actionTarget ? (
        <OptionSheet
          title={actionTarget.name}
          items={actionItems}
          onSelect={handleAction}
          onClose={() => setActionTarget(null)}
        />
      ) : null}

      {editorTarget ? (
        <AutomationEditorSheet
          target={editorTarget}
          settings={settings}
          onSubmit={submitEditor}
          onClose={() => setEditorTarget(null)}
        />
      ) : null}

      {historyTarget ? (
        <AutomationHistorySheet
          automation={historyTarget}
          runs={runsByAutomation[historyTarget.id] ?? null}
          loading={historyLoading}
          onOpenRun={openRun}
          onClose={() => setHistoryTarget(null)}
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface[0] },
  header: { minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2], paddingHorizontal: theme.spacing[2], borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border.default },
  headerButton: { width: theme.minTouchTarget, height: theme.minTouchTarget, alignItems: 'center', justifyContent: 'center', borderRadius: theme.radius.full },
  headerButtonPressed: { backgroundColor: theme.colors.surface[2] },
  headerCopy: { flex: 1 },
  cacheBanner: { paddingHorizontal: theme.spacing[4], paddingVertical: theme.spacing[2], backgroundColor: theme.colors.warning.muted },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.spacing[3], padding: theme.spacing[6] },
}))
