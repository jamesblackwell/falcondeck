import { memo, useCallback, useEffect } from 'react'
import { Pressable } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated'
import { ChevronDown } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'

interface JumpToBottomFabProps {
  visible: boolean
  onPress: () => void
}

export const JumpToBottomFab = memo(function JumpToBottomFab({
  visible,
  onPress,
}: JumpToBottomFabProps) {
  const { theme } = useUnistyles()
  const opacity = useSharedValue(0)
  const translateY = useSharedValue(20)

  useEffect(() => {
    const config = { duration: 200, easing: Easing.out(Easing.cubic) }
    opacity.value = withTiming(visible ? 1 : 0, config)
    translateY.value = withTiming(visible ? 0 : 20, config)
  }, [visible, opacity, translateY])

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }))

  const handlePress = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    onPress()
  }, [onPress])

  return (
    <Animated.View style={[styles.wrapper, animatedStyle]} pointerEvents={visible ? 'auto' : 'none'}>
      <Pressable style={styles.button} onPress={handlePress}>
        <ChevronDown size={20} color={theme.colors.fg.primary} />
      </Pressable>
    </Animated.View>
  )
})

const styles = StyleSheet.create((theme) => ({
  wrapper: {
    position: 'absolute',
    bottom: theme.spacing[3],
    alignSelf: 'center',
  },
  button: {
    width: 40,
    height: 40,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surface[3],
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    alignItems: 'center',
    justifyContent: 'center',
    ...theme.shadow.md,
  },
}))
