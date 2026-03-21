import { memo, useCallback } from 'react'
import { Pressable } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Square } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'

interface StopButtonProps {
  onPress: () => void
}

export const StopButton = memo(function StopButton({ onPress }: StopButtonProps) {
  const { theme } = useUnistyles()

  /* v8 ignore start */
  const handlePress = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    onPress()
  }, [onPress])
  /* v8 ignore stop */

  return (
    <Pressable style={styles.button} onPress={handlePress}>
      <Square size={14} color={theme.colors.surface[0]} fill={theme.colors.surface[0]} />
    </Pressable>
  )
})

const styles = StyleSheet.create((theme) => ({
  button: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.danger.default,
    alignItems: 'center',
    justifyContent: 'center',
  },
}))
