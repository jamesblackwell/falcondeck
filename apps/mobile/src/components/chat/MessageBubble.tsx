import { memo } from 'react'
import { View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

import type { ConversationItem } from '@falcondeck/client-core'

import { Text } from '@/components/ui'

interface MessageBubbleProps {
  item: ConversationItem
}

export const MessageBubble = memo(function MessageBubble({ item }: MessageBubbleProps) {
  if (item.kind === 'reasoning') return null

  if (item.kind === 'user_message') {
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble}>
          <Text color="primary">{item.text}</Text>
        </View>
      </View>
    )
  }

  if (item.kind === 'assistant_message') {
    return (
      <View style={styles.assistantRow}>
        <Text color="primary" style={styles.assistantText}>
          {item.text}
        </Text>
      </View>
    )
  }

  if (item.kind === 'tool_call') {
    return (
      <View style={styles.toolRow}>
        <View style={styles.toolCard}>
          <Text variant="mono" color="tertiary" size="xs">
            {item.title}
          </Text>
          {item.output ? (
            <Text variant="mono" color="muted" size="2xs" numberOfLines={4}>
              {item.output}
            </Text>
          ) : null}
        </View>
      </View>
    )
  }

  if (item.kind === 'service') {
    return (
      <View style={styles.serviceRow}>
        <Text variant="caption" color="muted" style={styles.serviceText}>
          {item.message}
        </Text>
      </View>
    )
  }

  return null
})

const styles = StyleSheet.create((theme) => ({
  userRow: {
    alignItems: 'flex-end',
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[1],
  },
  userBubble: {
    maxWidth: '80%',
    backgroundColor: theme.colors.surface[3],
    borderRadius: theme.radius.xl,
    borderCurve: 'continuous',
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  assistantRow: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[1],
  },
  assistantText: {
    lineHeight: 24,
  },
  toolRow: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[1],
  },
  toolCard: {
    backgroundColor: theme.colors.surface[2],
    borderRadius: theme.radius.lg,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: theme.colors.border.subtle,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
  },
  serviceRow: {
    alignItems: 'center',
    paddingVertical: theme.spacing[2],
  },
  serviceText: {
    textAlign: 'center',
    fontStyle: 'italic',
  },
}))
