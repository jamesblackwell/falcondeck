import { memo } from 'react'
import { StyleSheet } from 'react-native-unistyles'

import { Text } from '@/components/ui'

interface MarkdownRendererProps {
  text: string
}

// TODO: restore react-native-markdown-display once entities/hermes compatibility is resolved
export const MarkdownRenderer = memo(
  function MarkdownRenderer({ text }: MarkdownRendererProps) {
    return (
      <Text color="primary" style={styles.text}>
        {text}
      </Text>
    )
  },
  (prev, next) => prev.text === next.text,
)

const styles = StyleSheet.create({
  text: {
    lineHeight: 24,
  },
})
