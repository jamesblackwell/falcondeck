import { memo } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { CircleStop, X } from 'lucide-react-native'

import { Text } from '@/components/ui'
import { layeredFill } from '@/theme/color'

interface InterruptedTurnNoticeProps {
  onContinue: () => void
  onDismiss: () => void
  isContinuing?: boolean
}

export const InterruptedTurnNotice = memo(function InterruptedTurnNotice({
  onContinue,
  onDismiss,
  isContinuing = false,
}: InterruptedTurnNoticeProps) {
  const { theme } = useUnistyles()

  return (
    <View
      style={styles.container}
      accessibilityLabel="This response stopped when FalconDeck closed"
    >
      <CircleStop size={theme.iconSize.sm} color={theme.colors.danger.default} />
      <View style={styles.copy}>
        <Text variant="label" size="sm" weight="semibold" color="primary">
          This response stopped when FalconDeck closed
        </Text>
        <Text variant="caption" size="xs" color="secondary">
          The conversation is safe. Continue from where the agent left off.
        </Text>
      </View>
      <Pressable
        onPress={onContinue}
        disabled={isContinuing}
        accessibilityRole="button"
        accessibilityLabel={isContinuing ? 'Continuing' : 'Continue'}
        hitSlop={8}
        style={styles.continue}
      >
        <Text variant="label" size="sm" weight="semibold" color="accent">
          {isContinuing ? 'Continuing…' : 'Continue'}
        </Text>
      </Pressable>
      <Pressable
        onPress={onDismiss}
        disabled={isContinuing}
        accessibilityRole="button"
        accessibilityLabel="Dismiss stopped-turn notice"
        hitSlop={8}
        style={styles.dismiss}
      >
        <X size={theme.iconSize.xs} color={theme.colors.fg.muted} />
      </Pressable>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    marginHorizontal: 10,
    marginBottom: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.radius.xl,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.danger.default,
    // Opaque: the notice floats over the transcript, above the composer.
    ...layeredFill(theme.colors.surface[1], theme.colors.danger.muted),
  },
  copy: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  continue: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  dismiss: {
    padding: theme.spacing[1],
  },
}))
