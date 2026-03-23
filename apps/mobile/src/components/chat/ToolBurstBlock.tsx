import { memo } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import Animated from 'react-native-reanimated'
import { ChevronRight, Layers } from 'lucide-react-native'

import type { ConversationItem, ToolBurstSummary } from '@falcondeck/client-core'

import { Text } from '@/components/ui'
import { ToolCallBlock } from './ToolCallBlock'
import { useCollapsible } from './useCollapsible'

type ToolCall = Extract<ConversationItem, { kind: 'tool_call' }>

interface ToolBurstBlockProps {
  items: ToolCall[]
  summary: ToolBurstSummary
  defaultOpen: boolean
  suppressDetail: boolean
}

export const ToolBurstBlock = memo(function ToolBurstBlock({
  items,
  summary,
  defaultOpen,
  suppressDetail,
}: ToolBurstBlockProps) {
  const { theme } = useUnistyles()
  const { bodyStyle, chevronStyle, onContentLayout, toggle } = useCollapsible(defaultOpen)

  const label = summary.labels.slice(0, 2).join(', ')
  const summaryText = `${summary.count} read-only tool${summary.count === 1 ? '' : 's'}`

  return (
    <View style={styles.container}>
      <Pressable style={styles.header} onPress={toggle}>
        <Layers size={14} color={theme.colors.fg.muted} />
        <View style={styles.headerText}>
          <Text variant="caption" color="secondary">
            {summaryText}
          </Text>
          {label ? (
            <Text variant="caption" color="muted" size="2xs" numberOfLines={1}>
              {label}
            </Text>
          ) : null}
        </View>
        <Animated.View style={chevronStyle}>
          <ChevronRight size={14} color={theme.colors.fg.muted} />
        </Animated.View>
      </Pressable>
      <Animated.View style={bodyStyle}>
        <View onLayout={onContentLayout}>
          <View style={styles.body}>
            {items.map((item) => (
              <ToolCallBlock
                key={item.id}
                item={item}
                defaultOpen={false}
                suppressDetail={suppressDetail}
              />
            ))}
          </View>
        </View>
      </Animated.View>
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
  headerText: {
    flex: 1,
    gap: 2,
  },
  body: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border.subtle,
    paddingVertical: theme.spacing[1],
    gap: theme.spacing[1],
  },
}))
