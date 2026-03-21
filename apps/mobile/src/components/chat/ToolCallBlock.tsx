import { memo } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import Animated from 'react-native-reanimated'
import { ChevronRight, CheckCircle2, Circle, Loader2 } from 'lucide-react-native'

import type { ConversationItem } from '@falcondeck/client-core'

import { Text } from '@/components/ui'
import { useCollapsible } from './useCollapsible'

type ToolCall = Extract<ConversationItem, { kind: 'tool_call' }>

interface ToolCallBlockProps {
  item: ToolCall
  defaultOpen: boolean
  suppressDetail: boolean
}

export const ToolCallBlock = memo(function ToolCallBlock({
  item,
  defaultOpen,
  suppressDetail,
}: ToolCallBlockProps) {
  const { theme } = useUnistyles()
  const { bodyStyle, chevronStyle, isOpen, onContentLayout, toggle } = useCollapsible(defaultOpen)

  const isRunning = item.status === 'running' || item.status === 'in_progress'
  const isCompleted = item.status === 'completed' || item.status === 'success'
  const StatusIcon = isRunning ? Loader2 : isCompleted ? CheckCircle2 : Circle
  const statusColor = isRunning
    ? theme.colors.accent.default
    : isCompleted
      ? theme.colors.success.default
      : theme.colors.fg.faint

  const hasContent = item.output && !suppressDetail

  return (
    <View style={styles.container}>
      <Pressable style={styles.header} onPress={hasContent ? toggle : undefined}>
        <StatusIcon size={14} color={statusColor} />
        <Text variant="mono" color="tertiary" size="xs" style={styles.title} numberOfLines={1}>
          {item.title}
        </Text>
        {hasContent ? (
          <Animated.View style={chevronStyle}>
            <ChevronRight size={14} color={theme.colors.fg.muted} />
          </Animated.View>
        ) : null}
      </Pressable>
      {hasContent ? (
        <Animated.View style={bodyStyle}>
          <View onLayout={onContentLayout}>
            <View style={styles.body}>
              <Text variant="mono" color="muted" size="2xs" numberOfLines={isOpen ? undefined : 4}>
                {item.output}
              </Text>
            </View>
          </View>
        </Animated.View>
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.surface[2],
    borderRadius: theme.radius.lg,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: theme.colors.border.subtle,
    marginHorizontal: theme.spacing[4],
    marginVertical: theme.spacing[1],
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  title: {
    flex: 1,
  },
  body: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border.subtle,
    paddingTop: theme.spacing[2],
  },
}))
