import { memo } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Target } from 'lucide-react-native'

import type { ThreadGoal } from '@falcondeck/client-core'

import { Text } from '@/components/ui'

import { goalStatusLabel, goalStatusTone, goalUsageLine } from './goal'

interface GoalBannerProps {
  goal: ThreadGoal | null
  onPress: () => void
}

/** The thread's objective, pinned above the composer the way plans are — a
    goal changes what every following turn is for, so it stays in view. */
export const GoalBanner = memo(function GoalBanner({ goal, onPress }: GoalBannerProps) {
  const { theme } = useUnistyles()

  if (!goal) return null

  const tone = goalStatusTone(goal.status)
  const usage = goalUsageLine(goal)

  return (
    <Pressable
      style={styles.container}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Goal: ${goal.objective}. ${goalStatusLabel(goal.status)}.`}
      accessibilityHint="Opens goal options"
    >
      <Target size={theme.iconSize.xs} color={theme.colors.fg.muted} />
      <View style={styles.body}>
        <Text variant="caption" size="xs" color="secondary" numberOfLines={1}>
          {goal.objective}
        </Text>
        {usage ? (
          <Text variant="caption" size="2xs" color="muted" numberOfLines={1}>
            {usage}
          </Text>
        ) : null}
      </View>
      <View style={[styles.pill, styles[`pill_${tone}`]]}>
        <Text
          variant="caption"
          size="2xs"
          weight="semibold"
          color={tone === 'neutral' ? 'muted' : tone === 'success' ? 'success' : 'accent'}
        >
          {goalStatusLabel(goal.status)}
        </Text>
      </View>
    </Pressable>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    minHeight: theme.minTouchTarget,
    marginHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.radius.lg,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: theme.colors.border.subtle,
    backgroundColor: theme.colors.surface[2],
  },
  body: {
    flex: 1,
    gap: theme.spacing[0.5],
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
