import { memo } from 'react'
import { View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { CheckCircle2, Circle, Loader2 } from 'lucide-react-native'

import type { ConversationItem } from '@falcondeck/client-core'

import { Text } from '@/components/ui'

type PlanItem = Extract<ConversationItem, { kind: 'plan' }>

interface PlanBlockProps {
  item: PlanItem
}

export const PlanBlock = memo(function PlanBlock({ item }: PlanBlockProps) {
  const { theme } = useUnistyles()

  return (
    <View style={styles.container}>
      {item.plan.explanation ? (
        <Text color="secondary" size="sm" style={styles.explanation}>
          {item.plan.explanation}
        </Text>
      ) : null}
      <View style={styles.steps}>
        {item.plan.steps.map((step, index) => {
          const isDone = step.status === 'done' || step.status === 'completed'
          const isInProgress = step.status === 'in_progress' || step.status === 'running'
          const Icon = isDone ? CheckCircle2 : isInProgress ? Loader2 : Circle
          const iconColor = isDone
            ? theme.colors.success.default
            : isInProgress
              ? theme.colors.accent.default
              : theme.colors.fg.faint

          return (
            <View key={index} style={styles.stepRow}>
              <Icon size={14} color={iconColor} />
              <Text
                color={isDone ? 'muted' : 'primary'}
                size="sm"
                style={[styles.stepText, isDone && styles.stepDone]}
              >
                {step.step}
              </Text>
            </View>
          )
        })}
      </View>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.surface[2],
    borderRadius: theme.radius.lg,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: theme.colors.border.subtle,
    marginHorizontal: theme.spacing[4],
    marginVertical: theme.spacing[1],
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  explanation: {
    lineHeight: 20,
  },
  steps: {
    gap: theme.spacing[2],
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing[2],
  },
  stepText: {
    flex: 1,
    lineHeight: 20,
  },
  stepDone: {
    textDecorationLine: 'line-through',
    opacity: 0.6,
  },
}))
