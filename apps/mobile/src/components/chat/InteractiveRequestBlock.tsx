import { memo, useState } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Ban, CheckCircle2, ChevronRight, Circle, Clock3 } from 'lucide-react-native'

import {
  interactiveRequestEvidencePresentation,
  interactiveRequestReceiptPresentation,
  type ConversationItem,
} from '@falcondeck/client-core'

import { Text } from '@/components/ui'
import { CodeBlock } from './CodeBlock'

type InteractiveRequestItem = Extract<ConversationItem, { kind: 'interactive_request' }>

interface InteractiveRequestBlockProps {
  item: InteractiveRequestItem
}

export const InteractiveRequestBlock = memo(function InteractiveRequestBlock({
  item,
}: InteractiveRequestBlockProps) {
  const { theme } = useUnistyles()
  const request = item.request
  const evidence = interactiveRequestEvidencePresentation(request)
  const [receiptExpanded, setReceiptExpanded] = useState(false)

  // Live requests belong to the pinned InteractiveRequestBanner, which knows
  // the full flow (question forms, AlwaysAllow, offered decisions). An inline
  // Deny/Allow pair here was wrong for questions (the daemon rejects approval
  // responses to them) and ignored approval_decisions, so the transcript only
  // renders the resolved receipt.
  if (!item.resolved) {
    return null
  }

  const receipt = interactiveRequestReceiptPresentation(request, item.resolution)
  const hasEvidence = Boolean(
    evidence.command || evidence.path || evidence.detail || evidence.questions.length,
  )
  const color =
    receipt.tone === 'success'
      ? theme.colors.success.default
      : receipt.tone === 'danger'
        ? theme.colors.danger.default
        : receipt.tone === 'warning'
          ? theme.colors.warning.default
          : receipt.tone === 'info'
            ? theme.colors.info.default
            : theme.colors.fg.muted
  const ReceiptIcon =
    receipt.tone === 'success' || receipt.tone === 'info'
      ? CheckCircle2
      : receipt.tone === 'danger'
        ? Ban
        : receipt.tone === 'warning'
          ? Clock3
          : Circle
  const receiptLabel = evidence.summary ? `${receipt.label}. ${evidence.summary}` : receipt.label
  const header = (
    <>
      <ReceiptIcon accessible={false} size={14} color={color} />
      <Text variant="caption" color="secondary" numberOfLines={1} style={styles.receiptLabel}>
        {receipt.label}
      </Text>
      {evidence.summary ? (
        <Text variant="mono" color="tertiary" size="xs" numberOfLines={1} style={styles.receiptSummary}>
          {evidence.summary}
        </Text>
      ) : null}
      {hasEvidence ? (
        <ChevronRight
          accessible={false}
          size={theme.iconSize.xs}
          color={theme.colors.fg.faint}
          style={receiptExpanded ? styles.receiptChevronExpanded : undefined}
        />
      ) : null}
    </>
  )
  return (
    <View style={styles.receiptContainer}>
      {hasEvidence ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={receiptLabel}
          accessibilityHint={receiptExpanded ? 'Collapses request evidence' : 'Expands request evidence'}
          accessibilityState={{ expanded: receiptExpanded }}
          onPress={() => setReceiptExpanded((value) => !value)}
          style={styles.receipt}
        >
          {header}
        </Pressable>
      ) : (
        <View
          accessible
          accessibilityRole="text"
          accessibilityLabel={receiptLabel}
          style={styles.receipt}
        >
          {header}
        </View>
      )}
      {receiptExpanded ? (
        <View style={styles.receiptEvidence}>
          {evidence.command ? (
            <CodeBlock code={evidence.command} language="command" previewLines={3} />
          ) : null}
          {evidence.path ? (
            <Text selectable variant="mono" color="tertiary" size="xs">
              {evidence.path}
            </Text>
          ) : null}
          {evidence.detail ? (
            <Text selectable variant="caption" color="secondary">
              {evidence.detail}
            </Text>
          ) : null}
          {evidence.questions.map((question, questionIndex) => (
            <View key={`${question.id}-${questionIndex}`} style={styles.receiptQuestion}>
              <Text selectable variant="caption" color="muted" weight="semibold">
                {question.header}
              </Text>
              <Text selectable variant="caption" color="secondary">
                {question.question}
              </Text>
              {question.options?.map((option, index) => (
                <Text
                  key={`${question.id}-${index}-${option.label}`}
                  selectable
                  variant="caption"
                  color="tertiary"
                  size="xs"
                  style={styles.receiptOption}
                >
                  {option.label}{option.description ? ` — ${option.description}` : ''}
                </Text>
              ))}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  receiptContainer: {
    marginHorizontal: theme.spacing[4],
    marginVertical: theme.spacing[1],
    borderRadius: theme.radius.md,
    borderCurve: 'continuous',
    overflow: 'hidden',
    backgroundColor: theme.colors.surface[2],
  },
  receipt: {
    minHeight: theme.minTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  receiptLabel: {
    flexShrink: 0,
  },
  receiptSummary: {
    flex: 1,
  },
  receiptChevronExpanded: {
    transform: [{ rotate: '90deg' }],
  },
  receiptEvidence: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border.subtle,
    backgroundColor: theme.colors.surface[1],
  },
  receiptQuestion: {
    gap: theme.spacing[1],
  },
  receiptOption: {
    paddingLeft: theme.spacing[3],
  },
}))
