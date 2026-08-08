import { memo, useMemo, useState } from 'react'
import { View, ScrollView, Pressable } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { ChevronDown, ChevronUp } from 'lucide-react-native'
import * as Clipboard from 'expo-clipboard'

import { Text, Button } from '@/components/ui'

interface CodeBlockProps {
  code: string
  language?: string
  previewLines?: number
}

const DEFAULT_PREVIEW_LINES = 12

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  previewLines = DEFAULT_PREVIEW_LINES,
}: CodeBlockProps) {
  const { theme } = useUnistyles()
  const [expanded, setExpanded] = useState(false)
  const isDiff = language === 'diff'
  const headerLabel = language ?? 'code'
  const lines = useMemo(() => code.split('\n'), [code])
  const hiddenLineCount = previewLines > 0 ? Math.max(0, lines.length - previewLines) : 0
  const visibleLines = hiddenLineCount > 0 && !expanded ? lines.slice(0, previewLines) : lines

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text variant="caption" color="muted" size="2xs">
          {headerLabel}
        </Text>
        {hiddenLineCount > 0 ? (
          <Text variant="caption" color="muted" size="2xs">
            {lines.length} lines
          </Text>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          label="Copy"
          onPress={() => void Clipboard.setStringAsync(code)}
        />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {isDiff ? (
          <View style={styles.diffContainer}>
            {visibleLines.map((line, i) => {
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
            {visibleLines.join('\n')}
          </Text>
        )}
      </ScrollView>
      {hiddenLineCount > 0 ? (
        <Pressable
          style={styles.expandButton}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={expanded ? 'Collapse code' : `Show ${hiddenLineCount} more lines`}
          onPress={() => setExpanded((current) => !current)}
        >
          <Text variant="caption" color="muted" size="xs">
            {expanded
              ? 'Show less'
              : `Show ${hiddenLineCount} more line${hiddenLineCount === 1 ? '' : 's'}`}
          </Text>
          {expanded ? (
            <ChevronUp size={theme.iconSize.xs} color={theme.colors.fg.muted} />
          ) : (
            <ChevronDown size={theme.iconSize.xs} color={theme.colors.fg.muted} />
          )}
        </Pressable>
      ) : null}
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
    gap: theme.spacing[2],
  },
  code: {
    padding: theme.spacing[3],
    lineHeight: theme.fontSize.sm * theme.lineHeight.relaxed,
    textAlign: 'left',
  },
  diffContainer: {
    padding: theme.spacing[3],
  },
  codeLine: {
    lineHeight: theme.fontSize.sm * theme.lineHeight.relaxed,
    paddingHorizontal: theme.spacing[1],
    textAlign: 'left',
  },
  codeLineAdded: {
    backgroundColor: theme.colors.diff.added,
    color: theme.colors.diff.addedText,
  },
  codeLineRemoved: {
    backgroundColor: theme.colors.diff.removed,
    color: theme.colors.diff.removedText,
  },
  expandButton: {
    minHeight: theme.minTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border.subtle,
  },
}))
