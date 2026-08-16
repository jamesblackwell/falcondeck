import { memo, useMemo, useState } from 'react'
import { View, ScrollView, Pressable } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Check, ChevronDown, ChevronUp, CircleX, Copy } from 'lucide-react-native'

import { Text, Button } from '@/components/ui'
import { useClipboardCopy } from './useClipboardCopy'

interface CodeBlockProps {
  code: string
  language?: string
  previewLines?: number
}

const DEFAULT_PREVIEW_LINES = 12
const MAX_RENDERED_CHARS = 120_000
const MAX_EXPANDED_LINES = 400

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  previewLines = DEFAULT_PREVIEW_LINES,
}: CodeBlockProps) {
  const { theme } = useUnistyles()
  const [expanded, setExpanded] = useState(false)
  const isDiff = language === 'diff'
  const headerLabel = language ?? 'code'
  const displayCode = useMemo(() => code.slice(0, MAX_RENDERED_CHARS), [code])
  const lines = useMemo(() => displayCode.split('\n'), [displayCode])
  const expandedLineCount = Math.min(lines.length, MAX_EXPANDED_LINES)
  const previewLineCount = previewLines > 0
    ? Math.min(previewLines, expandedLineCount)
    : expandedLineCount
  const hiddenLineCount = Math.max(0, expandedLineCount - previewLineCount)
  const expandLabel = `Show ${hiddenLineCount} more line${hiddenLineCount === 1 ? '' : 's'}`
  const visibleLines = lines.slice(0, expanded ? expandedLineCount : previewLineCount)
  const displayLimited = code.length > displayCode.length || lines.length > MAX_EXPANDED_LINES
  const { copy, result: copyResult } = useClipboardCopy(
    code,
    'Code copied',
    'Could not copy code',
  )
  const copyLabel = copyResult === 'copied' ? 'Copied' : copyResult === 'failed' ? 'Retry' : 'Copy'
  const copyAccessibilityLabel = copyResult === 'copied'
    ? 'Code copied'
    : copyResult === 'failed'
      ? 'Could not copy code. Retry'
      : 'Copy code'
  const copyIcon = copyResult === 'copied' ? (
    <Check size={theme.iconSize.xs} color={theme.colors.success.default} />
  ) : copyResult === 'failed' ? (
    <CircleX size={theme.iconSize.xs} color={theme.colors.danger.default} />
  ) : (
    <Copy size={theme.iconSize.xs} color={theme.colors.fg.muted} />
  )

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text variant="caption" color="muted" size="2xs">
          {headerLabel}
        </Text>
        {hiddenLineCount > 0 || displayLimited ? (
          <Text variant="caption" color="muted" size="2xs">
            {code.length > displayCode.length ? `${lines.length}+` : lines.length} lines
          </Text>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          label={copyLabel}
          icon={copyIcon}
          accessibilityLabel={copyAccessibilityLabel}
          accessibilityLiveRegion="polite"
          onPress={() => { void copy() }}
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
                  selectable
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
          <Text selectable variant="mono" color="secondary" style={styles.code}>
            {visibleLines.join('\n')}
          </Text>
        )}
      </ScrollView>
      {hiddenLineCount > 0 ? (
        <Pressable
          style={styles.expandButton}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={expanded ? 'Collapse code' : expandLabel}
          onPress={() => setExpanded((current) => !current)}
        >
          <Text variant="caption" color="muted" size="xs">
            {expanded
              ? 'Show less'
              : expandLabel}
          </Text>
          {expanded ? (
            <ChevronUp size={theme.iconSize.xs} color={theme.colors.fg.muted} />
          ) : (
            <ChevronDown size={theme.iconSize.xs} color={theme.colors.fg.muted} />
          )}
        </Pressable>
      ) : null}
      {displayLimited ? (
        <Text
          accessible
          accessibilityLiveRegion="polite"
          variant="caption"
          color="muted"
          size="2xs"
          style={styles.limitNotice}
        >
          Display limited for performance. Copy includes the complete output.
        </Text>
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
    lineHeight: theme.fontSize.sm * theme.lineHeight.code,
    textAlign: 'left',
  },
  diffContainer: {
    padding: theme.spacing[3],
  },
  codeLine: {
    lineHeight: theme.fontSize.sm * theme.lineHeight.code,
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
  limitNotice: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border.subtle,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
}))
