import { memo } from 'react'
import { Pressable, ScrollView, View, useWindowDimensions } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import type { Automation, AutomationRun } from '@falcondeck/client-core'

import { ActivityDiamond, Badge, NativeSheet, Text } from '@/components/ui'

const RUN_TONE: Record<AutomationRun['status'], 'default' | 'success' | 'warning' | 'danger'> = {
  queued: 'default',
  running: 'warning',
  succeeded: 'success',
  succeeded_no_action: 'success',
  failed: 'danger',
  skipped_overlap: 'default',
  skipped_dependency: 'warning',
  cancelled: 'default',
}

export const AutomationHistorySheet = memo(function AutomationHistorySheet({
  automation,
  runs,
  loading,
  onOpenRun,
  onClose,
}: {
  automation: Automation
  runs: AutomationRun[] | null
  loading: boolean
  onOpenRun: (run: AutomationRun) => void
  onClose: () => void
}) {
  const { height } = useWindowDimensions()
  const { theme } = useUnistyles()
  return (
    <NativeSheet onClose={onClose} accessibilityLabel="Close run history">
      <View style={styles.header}>
        <Text variant="heading" size="lg">Run history</Text>
        <Text variant="supporting" color="secondary" numberOfLines={1}>{automation.name}</Text>
        <Text variant="caption" color="muted">
          Previews are cached on this phone. Full results remain in their agent threads.
        </Text>
      </View>
      <ScrollView style={{ maxHeight: height * 0.62 }} contentContainerStyle={styles.content}>
        {loading && !runs ? (
          <View style={styles.center}>
            <ActivityDiamond color={theme.colors.accent.default} />
            <Text variant="caption" color="muted">Loading runs…</Text>
          </View>
        ) : !runs || runs.length === 0 ? (
          <Text variant="supporting" color="muted" style={styles.empty}>
            This automation has not run yet.
          </Text>
        ) : runs.map((run) => (
          <Pressable
            key={run.id}
            style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
            disabled={!run.thread_id || !run.runtime_workspace_id}
            onPress={() => onOpenRun(run)}
            accessibilityRole={run.thread_id && run.runtime_workspace_id ? 'button' : undefined}
            accessibilityLabel={`${run.status}, ${new Date(run.queued_at).toLocaleString()}`}
            accessibilityHint={run.thread_id ? 'Opens the agent thread for this run' : undefined}
          >
            <View style={styles.rowTop}>
              <Badge variant={RUN_TONE[run.status]}>{run.status.replaceAll('_', ' ')}</Badge>
              <Text variant="meta" color="muted">{new Date(run.queued_at).toLocaleString()}</Text>
            </View>
            <Text variant="supporting" color="secondary" numberOfLines={3}>
              {run.outcome_preview ?? run.error?.message ?? 'No result preview'}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </NativeSheet>
  )
})

const styles = StyleSheet.create((theme) => ({
  header: { paddingHorizontal: theme.spacing[5], paddingBottom: theme.spacing[3], gap: theme.spacing[1] },
  content: { paddingHorizontal: theme.spacing[4], paddingBottom: theme.spacing[5], gap: theme.spacing[2] },
  center: { paddingVertical: theme.spacing[8], alignItems: 'center', gap: theme.spacing[2] },
  empty: { paddingVertical: theme.spacing[8], textAlign: 'center' },
  row: { padding: theme.spacing[3], gap: theme.spacing[2], borderRadius: theme.radius.lg, backgroundColor: theme.colors.surface[2], borderWidth: 1, borderColor: theme.colors.border.default },
  pressed: { backgroundColor: theme.colors.surface[3] },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing[2] },
}))
