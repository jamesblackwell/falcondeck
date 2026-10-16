import { memo, useCallback, useRef, type ReactNode } from 'react'
import {
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { X } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import { useTabletLayout } from '@/hooks/useTabletLayout'
import { useGlassMode } from '@/lib/glass'
import { withAlpha } from '@/theme/color'

import { GlassSurface, glassFill } from './GlassSurface'
import { SymbolIcon } from './SymbolIcon'

interface NativeSheetProps {
  children: ReactNode
  onClose: () => void
  accessibilityLabel?: string
  contentStyle?: StyleProp<ViewStyle>
}

/** Widest a sheet gets on a tablet before it stops growing and centres. */
const TABLET_SHEET_MAX_WIDTH = 560
/** iOS 26 floats sheets this far in from the screen edges. */
const SHEET_INSET = 8
/** Concentric with the display's own corners at that inset. */
const SHEET_RADIUS = 34

const DISMISS_DRAG_DISTANCE = 80
const DISMISS_FLING_VELOCITY = 0.8
const OPEN_SPRING = { damping: 26, stiffness: 300, mass: 0.9 } as const
const CLOSE_TIMING = { duration: 200, easing: Easing.in(Easing.cubic) } as const

/**
 * The app's bottom sheet: rises from the bottom, takes only the height its
 * content needs, and closes from a tap on the dimmed backdrop, a drag down
 * on the grabber, the close button, or the system back gesture. The button
 * is the escape hatch that does not depend on knowing a gesture.
 *
 * It floats as an iOS 26 glass card — inset from the screen edges with a
 * large continuous corner — tinted toward the palette so option lists stay
 * easy to read over whatever is behind them.
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
  const { height: windowHeight } = useWindowDimensions()
  const { isTablet } = useTabletLayout()
  const glassMode = useGlassMode()
  const reducedMotion = useReducedMotion()

  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const closingRef = useRef(false)
  const sheetHeight = useRef(0)
  // Starts below the screen; the first layout springs it into place.
  const offset = useSharedValue(windowHeight)
  const hasOpened = useRef(false)

  const finishClose = useCallback(() => {
    onCloseRef.current()
  }, [])

  // Every dismissal path runs the sheet back down before the parent unmounts
  // it, so closing mirrors opening instead of vanishing mid-screen.
  const requestClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    if (reducedMotion) {
      finishClose()
      return
    }
    const distance = Math.max(sheetHeight.current, 240) + SHEET_INSET + insets.bottom
    // Close even when something interrupts the slide (finished is false
    // then): closingRef already turns every later dismissal away, so a close
    // that never completed would leave the sheet impossible to leave.
    offset.value = withTiming(distance, CLOSE_TIMING, () => {
      runOnJS(finishClose)()
    })
  }, [finishClose, insets.bottom, offset, reducedMotion])
  const requestCloseRef = useRef(requestClose)
  requestCloseRef.current = requestClose

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      sheetHeight.current = event.nativeEvent.layout.height
      if (hasOpened.current || closingRef.current) return
      hasOpened.current = true
      offset.value = reducedMotion ? 0 : withSpring(0, OPEN_SPRING)
    },
    [offset, reducedMotion],
  )

  // The pan responder lives on the grabber only; putting it on the whole
  // sheet would steal vertical drags from scrollable content inside.
  const panResponder = useRef(
    PanResponder.create({
      // Once closing, the grabber lets go: a drag would take over the slide
      // away and fight the dismissal.
      onStartShouldSetPanResponder: () => !closingRef.current,
      onMoveShouldSetPanResponder: (_event, gesture) => !closingRef.current && gesture.dy > 4,
      onPanResponderMove: (_event, gesture) => {
        if (closingRef.current) return
        // Upward drags meet resistance instead of detaching the sheet.
        offset.value = gesture.dy > 0 ? gesture.dy : gesture.dy / 6
      },
      onPanResponderRelease: (_event, gesture) => {
        if (closingRef.current) return
        if (gesture.dy > DISMISS_DRAG_DISTANCE || gesture.vy > DISMISS_FLING_VELOCITY) {
          requestCloseRef.current()
          return
        }
        offset.value = withSpring(0, OPEN_SPRING)
      },
      onPanResponderTerminate: () => {
        if (closingRef.current) return
        offset.value = withSpring(0, OPEN_SPRING)
      },
    }),
  ).current

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value }],
  }))

  const bottomInset = isTablet ? insets.bottom + theme.spacing[4] : SHEET_INSET
  // The card sits over the home indicator, so its own padding clears it.
  const contentBottomPadding = isTablet
    ? theme.spacing[4]
    : Math.max(insets.bottom - SHEET_INSET, theme.spacing[3]) + theme.spacing[1]

  return (
    <Modal transparent animationType="fade" onRequestClose={requestClose} statusBarTranslucent>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.root}
      >
        <Pressable
          style={[styles.backdrop, { backgroundColor: theme.colors.overlay }]}
          onPress={requestClose}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
        />
        <Animated.View
          onLayout={handleLayout}
          style={[
            styles.frame,
            // A sheet pinned to the full width of an iPad puts its controls a
            // hand-span apart; floating it keeps the same bottom-sheet shape
            // at a size the thumb can still cover.
            isTablet ? styles.frameTablet : null,
            { marginBottom: bottomInset },
            sheetStyle,
          ]}
          accessibilityViewIsModal
        >
          <GlassSurface
            radius={SHEET_RADIUS}
            // Glass under a reading surface: tinted toward the palette so
            // busy content behind cannot compete with the options.
            tint={withAlpha(
              theme.colors.surface[1],
              glassMode === 'liquid' ? (theme.isDark ? 0.62 : 0.7) : 0.86,
            )}
            intensity={80}
            highlight={false}
            contentStyle={[styles.card, { paddingBottom: contentBottomPadding }]}
          >
            <View style={styles.grabberZone} {...panResponder.panHandlers}>
              <View style={styles.grabber} />
            </View>
            <Pressable
              onPress={requestClose}
              accessibilityRole="button"
              accessibilityLabel={accessibilityLabel}
              hitSlop={8}
              style={({ pressed }) => [
                styles.closeButton,
                pressed && styles.closeButtonPressed,
              ]}
            >
              <SymbolIcon
                name="xmark"
                fallback={X}
                size={12}
                weight="bold"
                color={theme.colors.fg.secondary}
              />
            </Pressable>
            <View style={contentStyle}>{children}</View>
          </GlassSurface>
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
    ...StyleSheet.absoluteFillObject,
  },
  frame: {
    marginHorizontal: SHEET_INSET,
  },
  frameTablet: {
    width: '100%',
    maxWidth: TABLET_SHEET_MAX_WIDTH,
    alignSelf: 'center',
  },
  card: {
    paddingTop: 0,
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
    top: theme.spacing[3],
    right: theme.spacing[3],
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.full,
    backgroundColor: glassFill(theme.isDark),
    zIndex: 1,
  },
  closeButtonPressed: {
    backgroundColor: theme.isDark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(9, 9, 11, 0.1)',
  },
  grabber: {
    width: 36,
    height: 5,
    borderRadius: theme.radius.full,
    backgroundColor: theme.isDark ? 'rgba(255, 255, 255, 0.22)' : 'rgba(9, 9, 11, 0.16)',
  },
}))
