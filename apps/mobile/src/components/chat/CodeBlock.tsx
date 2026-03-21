import { memo, useMemo } from 'react'
import { View, ScrollView } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import * as Clipboard from 'expo-clipboard'

import { Text, Button } from '@/components/ui'

interface CodeBlockProps {
  code: string
  language?: string
}

export const CodeBlock = memo(function CodeBlock({ code, language }: CodeBlockProps) {
  useUnistyles()
  const isDiff = language === 'diff'
  const headerLabel = language ?? 'code'

  const diffLines = useMemo(() => {
    if (!isDiff) return null
    return code.split('\n')
  }, [code, isDiff])

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text variant="caption" color="muted" size="2xs">
          {headerLabel}
        </Text>
        <Button
          variant="ghost"
          size="sm"
          label="Copy"
          onPress={() => void Clipboard.setStringAsync(code)}
        />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {isDiff && diffLines ? (
          <View style={styles.diffContainer}>
            {diffLines.map((line, i) => {
              const isAdded = line.startsWith('+')
              const isRemoved = line.startsWith('-')

              return (
                <Text
                  key={i}
                  variant="mono"
                  color="secondary"
                  style={[
                    styles.codeLine,
                    isAdded ? styles.codeLineAdded : undefined,
                    isRemoved ? styles.codeLineRemoved : undefined,
                  ]}
                >
                  {line}
                </Text>
              )
            })}
          </View>
        ) : (
          <Text variant="mono" color="secondary" style={styles.code}>
            {code}
          </Text>
        )}
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
  diffContainer: {
    padding: theme.spacing[3],
  },
  codeLine: {
    lineHeight: 20,
    paddingHorizontal: theme.spacing[1],
  },
  codeLineAdded: {
    backgroundColor: theme.colors.diff.added,
    color: theme.colors.diff.addedText,
  },
  codeLineRemoved: {
    backgroundColor: theme.colors.diff.removed,
    color: theme.colors.diff.removedText,
  },
}))
