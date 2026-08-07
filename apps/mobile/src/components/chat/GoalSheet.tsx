import { memo, useCallback, useState } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Pause, Play, X } from 'lucide-react-native'

import type { AgentProvider, ThreadGoal } from '@falcondeck/client-core'

import { Button, Input, Text } from '@/components/ui'

import {
  goalCanPause,
  goalStatusLabel,
  goalStatusTone,
  goalSupportsBudget,
  goalUsageLine,
  parseTokenBudget,
} from './goal'

interface GoalSheetProps {
  goal: ThreadGoal | null
  provider: AgentProvider
  onSetGoal: (objective: string, tokenBudget: number | null) => Promise<void>
  onClearGoal: () => Promise<void>
  onSetGoalStatus: (status: 'active' | 'paused') => Promise<void>
  onClose: () => void
}

/** The objective a thread is working toward: what it is and how it is going
    when one is set, a form to state one when it is not. */
export const GoalSheet = memo(function GoalSheet({
  goal,
  provider,
  onSetGoal,
  onClearGoal,
  onSetGoalStatus,
  onClose,
}: GoalSheetProps) {
  const { theme } = useUnistyles()
  const insets = useSafeAreaInsets()
  const [objective, setObjective] = useState('')
  const [budget, setBudget] = useState('')
  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(
    (action: Promise<void>) => {
      setIsPending(true)
      setError(null)
      void action
        .then(() => {
          onClose()
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : 'Goal update failed')
        })
        .finally(() => {
          setIsPending(false)
        })
    },
    [onClose],
  )

  const supportsBudget = goalSupportsBudget(provider)
  const canSubmit = objective.trim().length > 0 && !isPending

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close"
      />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + theme.spacing[4] }]}>
          <View style={styles.handle} />

          {goal ? (
            <View style={styles.body}>
              <View style={styles.headerRow}>
                <Text variant="label" color="primary" weight="semibold" style={styles.headerTitle}>
                  Goal
                </Text>
                <StatusPill status={goal.status} />
              </View>
              <Text color="primary">{goal.objective}</Text>
              {goalUsageLine(goal) ? (
                <Text variant="caption" size="xs" color="muted">
                  {goalUsageLine(goal)}
                </Text>
              ) : null}

              <View style={styles.actions}>
                {goalCanPause(goal, provider) ? (
                  <Button
                    variant="secondary"
                    label={goal.status === 'paused' ? 'Resume' : 'Pause'}
                    disabled={isPending}
                    icon={
                      goal.status === 'paused' ? (
                        <Play size={theme.iconSize.sm} color={theme.colors.fg.primary} />
                      ) : (
                        <Pause size={theme.iconSize.sm} color={theme.colors.fg.primary} />
                      )
                    }
                    onPress={() =>
                      run(onSetGoalStatus(goal.status === 'paused' ? 'active' : 'paused'))
                    }
                  />
                ) : null}
                <Button
                  variant="outline"
                  label="Clear goal"
                  disabled={isPending}
                  icon={<X size={theme.iconSize.sm} color={theme.colors.danger.default} />}
                  onPress={() => run(onClearGoal())}
                />
              </View>
            </View>
          ) : (
            <View style={styles.body}>
              <Text variant="label" color="primary" weight="semibold">
                Set a goal
              </Text>
              <Text variant="caption" size="xs" color="muted">
                The agent keeps working turns until the objective is met.
              </Text>
              <Input
                style={styles.objectiveInput}
                value={objective}
                onChangeText={setObjective}
                placeholder="e.g. All tests pass and lint is clean"
                accessibilityLabel="Objective"
                multiline
                autoFocus
                editable={!isPending}
              />
              {supportsBudget ? (
                <Input
                  value={budget}
                  onChangeText={(next) => setBudget(next.replace(/[^0-9]/g, ''))}
                  placeholder="Token budget (optional)"
                  accessibilityLabel="Token budget"
                  keyboardType="number-pad"
                  editable={!isPending}
                />
              ) : null}
              <Button
                label={isPending ? 'Setting…' : 'Set goal'}
                disabled={!canSubmit}
                loading={isPending}
                onPress={() => run(onSetGoal(objective.trim(), parseTokenBudget(budget)))}
              />
            </View>
          )}

          {error ? (
            <Text variant="caption" size="xs" color="danger" style={styles.error}>
              {error}
            </Text>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
})

const StatusPill = memo(function StatusPill({ status }: { status: string }) {
  const tone = goalStatusTone(status)
  return (
    <View style={[styles.pill, styles[`pill_${tone}`]]}>
      <Text
        variant="caption"
        size="2xs"
        weight="semibold"
        color={tone === 'neutral' ? 'muted' : tone === 'success' ? 'success' : 'accent'}
      >
        {goalStatusLabel(status)}
      </Text>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  backdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
  },
  sheet: {
    backgroundColor: theme.colors.surface[1],
    borderTopLeftRadius: theme.radius['2xl'],
    borderTopRightRadius: theme.radius['2xl'],
    borderCurve: 'continuous',
    paddingHorizontal: theme.spacing[4],
  },
  handle: {
    width: theme.spacing[8] + theme.spacing[1],
    height: theme.spacing[1],
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.border.emphasis,
    alignSelf: 'center',
    marginTop: theme.spacing[2],
    marginBottom: theme.spacing[3],
  },
  body: {
    gap: theme.spacing[2],
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing[2],
  },
  headerTitle: {
    flex: 1,
  },
  objectiveInput: {
    // Overrides the single-line Input height so a full objective is visible.
    height: 88,
    paddingTop: theme.spacing[3],
    textAlignVertical: 'top',
  },
  actions: {
    flexDirection: 'row',
    gap: theme.spacing[2],
    paddingTop: theme.spacing[1],
  },
  error: {
    paddingTop: theme.spacing[2],
  },
  pill: {
    borderRadius: theme.radius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[0.5],
  },
  pill_success: { backgroundColor: theme.colors.success.muted },
  pill_accent: { backgroundColor: theme.colors.accent.muted },
  pill_neutral: { backgroundColor: theme.colors.surface[3] },
}))
