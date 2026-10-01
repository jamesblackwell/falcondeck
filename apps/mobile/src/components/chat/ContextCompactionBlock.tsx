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
  const iconSize = theme.iconSize.xs
  const icon = lifecycle === 'running' || lifecycle === 'queued'
    ? <ActivityDiamond size={iconSize} color={theme.colors.accent.default} />
    : lifecycle === 'succeeded'
      ? <CheckCircle2 accessible={false} size={iconSize} color={theme.colors.success.default} />
      : lifecycle === 'failed'
        ? <CircleX accessible={false} size={iconSize} color={theme.colors.danger.default} />
        : lifecycle === 'interrupted' || lifecycle === 'denied'
          ? <PauseCircle accessible={false} size={iconSize} color={theme.colors.warning.default} />
          : <BookOpen accessible={false} size={iconSize} color={theme.colors.fg.muted} />

  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole={lifecycle === 'failed' ? 'alert' : 'text'}
      accessibilityLiveRegion={lifecycle === 'failed' ? 'assertive' : 'polite'}
      accessibilityLabel={`${presentation.label}. ${presentation.detail}`}
    >
      <View style={styles.icon}>{icon}</View>
      <View style={styles.copy}>
        <Text variant="supporting" color="secondary" weight="medium">
          {presentation.label}
        </Text>
        <Text variant="meta">
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
    marginHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  icon: {
    alignItems: 'center',
    justifyContent: 'center',
    height: theme.fontSize.sm * theme.lineHeight.normal,
  },
  copy: {
    flex: 1,
    flexShrink: 1,
    gap: theme.spacing[0.5],
  },
}))
