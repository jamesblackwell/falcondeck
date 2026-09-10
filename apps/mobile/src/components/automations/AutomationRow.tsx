import { memo } from 'react'
import { Pressable, View } from 'react-native'
import { MoreHorizontal } from 'lucide-react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import { formatDueAt, type Automation } from '@falcondeck/client-core'

import { Badge, Text } from '@/components/ui'
import { automationScheduleSummary } from '@/features/automations/model'

export const AutomationRow = memo(function AutomationRow({
  automation,
  busy,
  nowTick = 0,
  onEdit,
  onOpenActions,
}: {
  automation: Automation
  busy: boolean
  /** Minute clock used to refresh relative due labels in this memoized row. */
  nowTick?: number
  onEdit: (automation: Automation) => void
  onOpenActions: (automation: Automation) => void
}) {
  const { theme } = useUnistyles()
  const due = formatDueAt(
    automation.next_run_at,
    nowTick > 0 ? nowTick * 60_000 : Date.now(),
  )
  const project =
    automation.target.workspace_path.split(/[\\/]/).filter(Boolean).at(-1) ?? null
  const lastFailed = automation.latest_outcome?.status === 'failed'
  const whenLabel =
    automation.state === 'paused'
      ? 'Paused'
      : automation.state === 'completed'
        ? 'Completed'
        : automation.state === 'failed'
          ? 'Failed'
          : due?.label ?? 'Not scheduled'
  return (
    <View style={[styles.row, busy ? styles.busy : null]}>
      <Pressable
        style={({ pressed }) => [styles.main, pressed ? styles.pressed : null]}
        onPress={() => onEdit(automation)}
        onLongPress={() => onOpenActions(automation)}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={`${automation.name}, ${automation.state}`}
        accessibilityHint="Opens the editor. Long press for actions."
      >
        <View style={styles.topLine}>
          <Text
            variant="label"
            color={automation.state === 'paused' ? 'secondary' : 'primary'}
            numberOfLines={1}
            style={styles.name}
          >
            {automation.name}
          </Text>
          <Text
            variant="meta"
            color={due?.overdue || automation.state === 'failed' ? 'danger' : 'muted'}
          >
            {whenLabel}
          </Text>
        </View>
        <Text variant="meta" color="muted" numberOfLines={1}>
          {automationScheduleSummary(automation)}
          {project ? ` · ${project}` : ''}
        </Text>
        {lastFailed ? (
          <Text variant="meta" color="danger" numberOfLines={1}>
            Last run failed
          </Text>
        ) : null}
        {automation.elevated ? <Badge variant="danger">Elevated</Badge> : null}
      </Pressable>
      <Pressable
        style={styles.more}
        onPress={() => onOpenActions(automation)}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={`Actions for ${automation.name}`}
        hitSlop={(theme.minTouchTarget - theme.iconSize.sm) / 2}
      >
        <MoreHorizontal size={theme.iconSize.sm} color={theme.colors.fg.muted} />
      </Pressable>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  row: { position: 'relative', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border.default },
  main: { paddingLeft: theme.spacing[4], paddingRight: theme.spacing[12], paddingVertical: theme.spacing[3], gap: theme.spacing[1.5] },
  pressed: { backgroundColor: theme.colors.surface[2] },
  busy: { opacity: 0.55 },
  topLine: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] },
  name: { flex: 1 },
  more: { position: 'absolute', right: theme.spacing[2], top: theme.spacing[2], width: theme.minTouchTarget, height: theme.minTouchTarget, alignItems: 'center', justifyContent: 'center', borderRadius: theme.radius.full },
}))
