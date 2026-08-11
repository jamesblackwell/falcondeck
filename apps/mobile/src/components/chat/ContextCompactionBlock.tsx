import { memo } from 'react'
import { View } from 'react-native'
import { BookOpen, CheckCircle2, CircleX, PauseCircle } from 'lucide-react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import {
  contextCompactionPresentation,
  type ConversationItem,
} from '@falcondeck/client-core'

import { ActivityDiamond, Text } from '@/components/ui'

type ContextCompactionItem = Extract<ConversationItem, { kind: 'context_compaction' }>

export const ContextCompactionBlock = memo(function ContextCompactionBlock({
  item,
}: {
  item: ContextCompactionItem
}) {
  const { theme } = useUnistyles()
  const lifecycle = item.lifecycle ?? 'unknown'
  const presentation = contextCompactionPresentation(lifecycle)
  const icon = lifecycle === 'running' || lifecycle === 'queued'
    ? <ActivityDiamond size={14} color={theme.colors.accent.default} />
    : lifecycle === 'succeeded'
      ? <CheckCircle2 accessible={false} size={14} color={theme.colors.success.default} />
      : lifecycle === 'failed'
        ? <CircleX accessible={false} size={14} color={theme.colors.danger.default} />
        : lifecycle === 'interrupted' || lifecycle === 'denied'
          ? <PauseCircle accessible={false} size={14} color={theme.colors.warning.default} />
          : <BookOpen accessible={false} size={14} color={theme.colors.fg.muted} />

  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole={lifecycle === 'failed' ? 'alert' : 'text'}
      accessibilityLiveRegion={lifecycle === 'failed' ? 'assertive' : 'polite'}
      accessibilityLabel={`${presentation.label}. ${presentation.detail}`}
    >
      {icon}
      <View style={styles.copy}>
        <Text variant="caption" color="secondary" size="xs" weight="medium" style={styles.text}>
          {presentation.label}
        </Text>
        <Text variant="caption" color="faint" size="2xs" style={styles.text}>
          {presentation.detail}
        </Text>
      </View>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  row: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: theme.spacing[2],
    justifyContent: 'center',
    marginHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  copy: {
    alignItems: 'center',
    flexShrink: 1,
    gap: theme.spacing[0.5],
  },
  text: {
    textAlign: 'center',
  },
}))
