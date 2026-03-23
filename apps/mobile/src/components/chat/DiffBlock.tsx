import { memo } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import Animated from 'react-native-reanimated'
import { ChevronRight, GitBranch } from 'lucide-react-native'

import type { ConversationItem } from '@falcondeck/client-core'

import { Text } from '@/components/ui'
import { CodeBlock } from './CodeBlock'
import { useCollapsible } from './useCollapsible'

type DiffItem = Extract<ConversationItem, { kind: 'diff' }>

interface DiffBlockProps {
  item: DiffItem
  defaultOpen: boolean
}

export const DiffBlock = memo(function DiffBlock({ item, defaultOpen }: DiffBlockProps) {
  const { theme } = useUnistyles()
  const { bodyStyle, chevronStyle, onContentLayout, toggle } = useCollapsible(defaultOpen)

  return (
    <View style={styles.container}>
      <Pressable style={styles.header} onPress={toggle}>
        <GitBranch size={14} color={theme.colors.fg.muted} />
        <Text variant="caption" color="secondary" style={styles.title}>
          Diff
        </Text>
        <Animated.View style={chevronStyle}>
          <ChevronRight size={14} color={theme.colors.fg.muted} />
        </Animated.View>
      </Pressable>
      <Animated.View style={bodyStyle}>
        <View onLayout={onContentLayout}>
          <View style={styles.body}>
            <CodeBlock code={item.diff} language="diff" />
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
  title: {
    flex: 1,
  },
  body: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border.subtle,
    padding: theme.spacing[2],
  },
}))
