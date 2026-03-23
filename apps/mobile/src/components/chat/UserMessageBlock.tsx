import { memo } from 'react'
import { View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

import type { ConversationItem } from '@falcondeck/client-core'

import { AttachmentPreviewList } from './AttachmentPreviewList'
import { MarkdownRenderer } from './MarkdownRenderer'

type UserMessage = Extract<ConversationItem, { kind: 'user_message' }>

interface UserMessageBlockProps {
  item: UserMessage
}

export const UserMessageBlock = memo(function UserMessageBlock({ item }: UserMessageBlockProps) {
  return (
    <View style={styles.row}>
      <View style={styles.bubble}>
        <AttachmentPreviewList attachments={item.attachments} />
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
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
}))
