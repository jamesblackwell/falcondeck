import { memo } from 'react'
import { View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

import type { ConversationItem } from '@falcondeck/client-core'

import { MarkdownRenderer } from './MarkdownRenderer'

type UserMessage = Extract<ConversationItem, { kind: 'user_message' }>

interface UserMessageBlockProps {
  item: UserMessage
}

export const UserMessageBlock = memo(function UserMessageBlock({ item }: UserMessageBlockProps) {
  return (
    <View style={styles.row}>
      <View style={styles.bubble}>
        <MarkdownRenderer text={item.text} />
      </View>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  row: {
    alignItems: 'flex-end',
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[1],
  },
  bubble: {
    maxWidth: '80%',
    backgroundColor: theme.colors.surface[3],
    borderRadius: theme.radius.xl,
    borderCurve: 'continuous',
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
}))
