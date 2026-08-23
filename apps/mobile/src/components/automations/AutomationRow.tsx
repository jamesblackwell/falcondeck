import { memo } from 'react'
import { Pressable, View } from 'react-native'
import { MoreHorizontal } from 'lucide-react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import type { Automation } from '@falcondeck/client-core'

import { Badge, Text } from '@/components/ui'
import { automationScheduleSummary } from '@/features/automations/model'

const STATE_TONE: Record<Automation['state'], 'default' | 'success' | 'warning' | 'danger'> = {
  enabled: 'success',
  paused: 'warning',
  completed: 'default',
  failed: 'danger',
}

export const AutomationRow = memo(function AutomationRow({
  automation,
  busy,
  onEdit,
  onOpenActions,
}: {
  automation: Automation
  busy: boolean
  onEdit: (automation: Automation) => void
  onOpenActions: (automation: Automation) => void
}) {
  const { theme } = useUnistyles()
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
          <Text variant="label" color="primary" numberOfLines={1} style={styles.name}>
            {automation.name}
          </Text>
          <Badge variant={STATE_TONE[automation.state]}>{automation.state}</Badge>
        </View>
        <Text variant="mono" size="xs" color="muted" numberOfLines={1}>
          {automationScheduleSummary(automation)}
        </Text>
        <Text variant="caption" color="muted" numberOfLines={1}>
          {automation.target.provider} · {automation.target.workspace_path}
        </Text>
        <Text variant="meta" color="muted" numberOfLines={1}>
          {automation.next_run_at
            ? `Next ${new Date(automation.next_run_at).toLocaleString()}`
            : 'No scheduled run'}
          {automation.latest_outcome
            ? ` · Last ${automation.latest_outcome.status.replaceAll('_', ' ')}`
            : ' · Never run'}
        </Text>
        {automation.elevated ? <Badge variant="danger">elevated</Badge> : null}
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
