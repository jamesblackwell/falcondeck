import { memo, useRef, type ReactNode } from 'react'
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { X } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

interface NativeSheetProps {
  children: ReactNode
  onClose: () => void
  accessibilityLabel?: string
  contentStyle?: StyleProp<ViewStyle>
}

const DISMISS_DRAG_DISTANCE = 80
const DISMISS_FLING_VELOCITY = 0.8

/**
 * The app's bottom sheet: slides up from the bottom, takes only the height
 * its content needs, and closes from a tap on the dimmed backdrop, a drag
 * down on the grabber, an explicit close button, or the system back gesture.
 * The button is the escape hatch that does not depend on knowing a gesture.
 *
 * Deliberately NOT the native iOS form sheet: on an iPhone that presents as
 * a nearly full-screen card regardless of content height, with no visible
 * way out beyond knowing the swipe gesture.
 */
export const NativeSheet = memo(function NativeSheet({
  children,
  onClose,
  accessibilityLabel = 'Close',
  contentStyle,
}: NativeSheetProps) {
  const { theme } = useUnistyles()
  const insets = useSafeAreaInsets()

  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const dragY = useRef(new Animated.Value(0)).current
  // The pan responder lives on the grabber only; putting it on the whole
  // sheet would steal vertical drags from scrollable content inside.
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_event, gesture) => gesture.dy > 4,
      onPanResponderMove: (_event, gesture) => {
        if (gesture.dy > 0) dragY.setValue(gesture.dy)
      },
      onPanResponderRelease: (_event, gesture) => {
        if (gesture.dy > DISMISS_DRAG_DISTANCE || gesture.vy > DISMISS_FLING_VELOCITY) {
          onCloseRef.current()
          return
        }
        Animated.spring(dragY, { toValue: 0, useNativeDriver: true }).start()
      },
    }),
  ).current

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.root}
      >
        <Pressable
          style={[styles.backdrop, { backgroundColor: theme.colors.overlay }]}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
        />
        <Animated.View
          style={[
            styles.content,
            { paddingBottom: insets.bottom + theme.spacing[4] },
            { transform: [{ translateY: dragY }] },
          ]}
        >
          <View style={styles.grabberZone} {...panResponder.panHandlers}>
            <View style={styles.grabber} />
          </View>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            hitSlop={8}
            style={({ pressed }) => [
              styles.closeButton,
              pressed && styles.closeButtonPressed,
            ]}
          >
            <X size={theme.iconSize.sm} color={theme.colors.fg.muted} />
          </Pressable>
          <View style={contentStyle}>{children}</View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  )
})

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    flex: 1,
  },
  content: {
    backgroundColor: theme.colors.surface[1],
    borderTopLeftRadius: theme.radius['2xl'],
    borderTopRightRadius: theme.radius['2xl'],
    borderCurve: 'continuous',
  },
  grabberZone: {
    alignItems: 'center',
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[3],
  },
  // Sits over the grabber row rather than in it, so the drag target stays the
  // full width and sheet content keeps its own header space.
  closeButton: {
    position: 'absolute',
    top: theme.spacing[2],
    right: theme.spacing[3],
    width: theme.spacing[8],
    height: theme.spacing[8],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surface[3],
  },
  closeButtonPressed: {
    backgroundColor: theme.colors.surface[4],
  },
  grabber: {
    width: theme.spacing[8] + theme.spacing[1],
    height: theme.spacing[1],
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.border.emphasis,
  },
}))
