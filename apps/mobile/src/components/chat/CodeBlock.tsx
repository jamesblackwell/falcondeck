import { memo } from 'react'
import { View, ScrollView } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import * as Clipboard from 'expo-clipboard'

import { Text, Button } from '@/components/ui'

interface CodeBlockProps {
  code: string
  language?: string
}

export const CodeBlock = memo(function CodeBlock({ code, language }: CodeBlockProps) {
  const { theme } = useUnistyles()

  return (
    <View style={styles.container}>
      {language ? (
        <View style={styles.header}>
          <Text variant="caption" color="muted" size="2xs">
            {language}
          </Text>
          <Button
            variant="ghost"
            size="sm"
            label="Copy"
            onPress={() => void Clipboard.setStringAsync(code)}
          />
        </View>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text variant="mono" color="secondary" style={styles.code}>
          {code}
        </Text>
      </ScrollView>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.surface[1],
    borderRadius: theme.radius.lg,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.subtle,
  },
  code: {
    padding: theme.spacing[3],
    lineHeight: 20,
  },
}))
