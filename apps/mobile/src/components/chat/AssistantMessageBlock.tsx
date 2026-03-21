import { memo } from 'react'
import { View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

import type { ConversationItem } from '@falcondeck/client-core'

import { MarkdownRenderer } from './MarkdownRenderer'

type AssistantMessage = Extract<ConversationItem, { kind: 'assistant_message' }>

interface AssistantMessageBlockProps {
  item: AssistantMessage
}

export const AssistantMessageBlock = memo(function AssistantMessageBlock({
  item,
}: AssistantMessageBlockProps) {
  return (
    <View style={styles.row}>
      <MarkdownRenderer text={item.text} />
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  row: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[1],
  },
}))
