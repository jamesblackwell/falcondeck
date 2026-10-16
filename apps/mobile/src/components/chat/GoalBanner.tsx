import { memo } from 'react'
import { Pressable } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Target } from 'lucide-react-native'

import type { ThreadGoal } from '@falcondeck/client-core'

import { GlassSurface, Text } from '@/components/ui'

import { goalStatusLabel, goalStatusTone, useGoalElapsedLabel } from './goal'

interface GoalBannerProps {
  goal: ThreadGoal | null
  onPress: () => void
}

/** A small centered bubble above the composer while a goal runs: the word
    "Goal" and how long it has been going. Tap for the objective, status,
    and stop — the compact sibling of the queued messages card. */
export const GoalBanner = memo(function GoalBanner({ goal, onPress }: GoalBannerProps) {
  const { theme } = useUnistyles()
  const elapsed = useGoalElapsedLabel(goal?.started_at ?? null)

  if (!goal) return null

  const tone = goalStatusTone(goal.status)

  return (
    <Pressable
      style={styles.pressable}
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={`Goal: ${goal.objective}${
        elapsed ? `, running for ${elapsed}` : ''
      }. ${goalStatusLabel(goal.status)}.`}
      accessibilityHint="Opens goal options"
    >
      <GlassSurface
        radius={16}
        interactive
        intensity={70}
        highlight={false}
        contentStyle={styles.container}
      >
        <Target
          size={theme.iconSize.xs}
          color={
            tone === 'accent'
              ? theme.colors.accent.default
              : tone === 'success'
                ? theme.colors.success.default
                : theme.colors.fg.muted
          }
        />
        <Text variant="caption" size="xs" weight="semibold" color="secondary">
          Goal
        </Text>
        <Text variant="caption" size="xs" color="muted" style={styles.elapsed}>
          {elapsed ?? goalStatusLabel(goal.status)}
        </Text>
      </GlassSurface>
    </Pressable>
  )
})

const styles = StyleSheet.create((theme) => ({
  pressable: {
    alignSelf: 'center',
    marginBottom: theme.spacing[2],
  },
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[1.5],
    minHeight: 32,
    paddingHorizontal: theme.spacing[3] + 2,
  },
  elapsed: {
    fontVariant: ['tabular-nums'],
  },
}))
