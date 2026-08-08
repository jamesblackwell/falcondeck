import { memo, useState } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Brain, ChevronRight } from 'lucide-react-native'

import type { ConversationItem, ThinkingDisplay } from '@falcondeck/client-core'

import { Text } from '@/components/ui'
import { useThinkingDisplay } from '@/store'
import { MarkdownRenderer } from './MarkdownRenderer'
import { reasoningHeaderLabel, resolveReasoningReveal } from './reasoning'

type ReasoningItem = Extract<ConversationItem, { kind: 'reasoning' }>

interface ReasoningBlockProps {
  item: ReasoningItem
  display: ThinkingDisplay
  /** Set when the thought renders inside a work session, which draws its own rule. */
  nested?: boolean
}

/** The agent's thinking, rendered as a quiet left rule rather than a card —
    it is context for the work, not a result of it. */
export const ReasoningBlock = memo(function ReasoningBlock({
  item,
  display,
  nested = false,
}: ReasoningBlockProps) {
  const { theme } = useUnistyles()
  const { collapsedLines, defaultOpen } = resolveReasoningReveal(display)
  const [isOpen, setIsOpen] = useState(defaultOpen)
  // FlashList recycles instances across blocks; without this render-phase
  // reset a thought the user expanded leaks its open state into whichever
  // reasoning row the cell renders next, flickering rows during scroll.
  const [appliedItemId, setAppliedItemId] = useState(item.id)
  if (appliedItemId !== item.id) {
    setAppliedItemId(item.id)
    setIsOpen(defaultOpen)
  }

  const label = reasoningHeaderLabel(item.summary)
  const hasBody = item.content.trim().length > 0
  const showPreview = !isOpen && collapsedLines > 0 && hasBody

  return (
    <View style={[styles.container, nested ? styles.containerNested : null]}>
      <Pressable
        style={styles.header}
        onPress={hasBody ? () => setIsOpen((current) => !current) : undefined}
        disabled={!hasBody}
        accessibilityRole="button"
        accessibilityState={{ expanded: isOpen, disabled: !hasBody }}
        accessibilityLabel={`Reasoning: ${label}`}
        accessibilityHint={hasBody ? 'Shows the full thought' : undefined}
      >
        <Brain size={theme.iconSize.xs} color={theme.colors.fg.faint} />
        <Text variant="label" color="muted" numberOfLines={1} style={styles.label}>
          {label}
        </Text>
        {hasBody ? (
          <ChevronRight
            size={theme.iconSize.xs}
            style={isOpen ? styles.chevronOpen : undefined}
            color={theme.colors.fg.faint}
          />
        ) : null}
      </Pressable>

      {isOpen && hasBody ? (
        <View style={styles.body}>
          <MarkdownRenderer text={item.content} />
        </View>
      ) : null}

      {showPreview ? (
        <Pressable style={styles.body} onPress={() => setIsOpen(true)} accessibilityRole="button">
          <Text variant="body" size="sm" color="muted" numberOfLines={collapsedLines}>
            {item.content}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
})

/** Reads the shared reveal preference. Split out from ReasoningBlock so only
    reasoning rows subscribe to the session store, not every transcript row. */
export const ConnectedReasoningBlock = memo(function ConnectedReasoningBlock({
  item,
  nested,
}: {
  item: ReasoningItem
  nested?: boolean
}) {
  const display = useThinkingDisplay()
  return <ReasoningBlock item={item} display={display} nested={nested} />
})

const styles = StyleSheet.create((theme) => ({
  container: {
    marginHorizontal: theme.spacing[4],
    marginVertical: theme.spacing[1],
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border.emphasis,
    paddingLeft: theme.spacing[3],
  },
  containerNested: {
    marginHorizontal: 0,
    borderLeftWidth: 0,
    paddingLeft: 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    // The painted row is short; keep the tap target at the HIG minimum.
    minHeight: theme.minTouchTarget,
  },
  label: {
    flex: 1,
  },
  chevronOpen: {
    transform: [{ rotate: '90deg' }],
  },
  body: {
    paddingBottom: theme.spacing[2],
  },
}))
