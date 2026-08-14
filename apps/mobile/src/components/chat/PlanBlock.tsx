import { memo, useMemo } from 'react'
import { View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { AlertTriangle, CheckCircle2, Circle, CircleX } from 'lucide-react-native'

import {
  planStepPresentations,
  planStepRenderKeys,
  type ConversationItem,
} from '@falcondeck/client-core'

import { ActivityDiamond, Text } from '@/components/ui'

type PlanItem = Extract<ConversationItem, { kind: 'plan' }>

interface PlanBlockProps {
  item: PlanItem
}

export const PlanBlock = memo(function PlanBlock({ item }: PlanBlockProps) {
  const { theme } = useUnistyles()
  const stepKeys = useMemo(() => planStepRenderKeys(item.plan.steps), [item.plan.steps])
  const presentations = useMemo(() => planStepPresentations(item.plan.steps), [item.plan.steps])

  return (
    <View style={styles.container}>
      <Text
        variant="label"
        color="tertiary"
        size="xs"
        weight="semibold"
        accessibilityRole="header"
        accessibilityLabel={`Plan, ${item.plan.steps.length} steps`}
      >
        Plan
      </Text>
      {item.plan.explanation ? (
        <Text selectable variant="supporting">
          {item.plan.explanation}
        </Text>
      ) : null}
      <View style={styles.steps}>
        {item.plan.steps.map((step, index) => {
          const presentation = presentations[index]
          const isDone = presentation.state === 'completed'
          const iconColor = isDone
            ? theme.colors.success.default
            : presentation.state === 'in_progress'
              ? theme.colors.accent.default
              : presentation.state === 'blocked'
                ? theme.colors.warning.default
                : presentation.state === 'failed'
                  ? theme.colors.danger.default
                  : theme.colors.fg.faint

          return (
            <View
              key={stepKeys[index]}
              style={styles.stepRow}
              accessible
              accessibilityRole="text"
              accessibilityLabel={`${step.step}, ${presentation.label}`}
            >
              {presentation.state === 'in_progress' ? (
                <ActivityDiamond size={14} color={iconColor} />
              ) : presentation.state === 'completed' ? (
                <CheckCircle2 accessible={false} size={14} color={iconColor} />
              ) : presentation.state === 'blocked' ? (
                <AlertTriangle accessible={false} size={14} color={iconColor} />
              ) : presentation.state === 'failed' ? (
                <CircleX accessible={false} size={14} color={iconColor} />
              ) : (
                <Circle accessible={false} size={14} color={iconColor} />
              )}
              <Text
                selectable
                color={isDone ? 'muted' : 'primary'}
                size="sm"
                style={[styles.stepText, isDone && styles.stepDone]}
              >
                {step.step}
              </Text>
              <Text
                variant="caption"
                size="2xs"
                color={presentation.state === 'failed' ? 'danger' : presentation.state === 'blocked' ? 'warning' : presentation.state === 'in_progress' ? 'accent' : 'muted'}
                style={styles.status}
              >
                {presentation.label}
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
    lineHeight: theme.fontSize.sm * theme.lineHeight.normal,
  },
  stepDone: {
    textDecorationLine: 'line-through',
    opacity: 0.6,
  },
  status: {
    flexShrink: 0,
  },
}))
