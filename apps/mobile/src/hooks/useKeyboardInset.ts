import { useEffect, useState } from 'react'
import {
  Keyboard,
  LayoutAnimation,
  Platform,
  useWindowDimensions,
  type KeyboardEvent,
} from 'react-native'

// iOS fires the `Will` pair ahead of the animation, so the layout settles in
// step with the keyboard instead of a frame behind it. Android only has `Did`.
const SHOW_EVENT = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
const HIDE_EVENT = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'

/** A docked keyboard ends exactly at the bottom edge; allow sub-pixel drift. */
const DOCKED_TOLERANCE_PX = 1

interface KeyboardMetrics {
  screenY: number
  height: number
}

/**
 * How much of the window's bottom a keyboard covers, or 0 when the frame is
 * not a docked keyboard sitting on the window's bottom edge.
 *
 * `KeyboardAvoidingView` trusts whatever frame iOS reports. Resuming the app
 * with the composer still focused fires an early `keyboardWillShow` whose
 * frame is not yet laid out against the window (screenY near 0, or a height
 * that does not reach the bottom edge), so the view padded by nearly the
 * whole screen: the transcript collapsed and the composer sat under the
 * header until the next keyboard event. Rejecting frames that do not touch
 * the bottom edge also means a floating iPad keyboard, which covers nothing
 * predictable, never pads at all.
 */
export function keyboardInsetFromMetrics(
  metrics: KeyboardMetrics | null | undefined,
  windowHeight: number,
): number {
  if (!metrics || windowHeight <= 0) return 0
  const { screenY, height } = metrics
  if (!(height > 0) || !(screenY > 0)) return 0
  if (Math.abs(screenY + height - windowHeight) > DOCKED_TOLERANCE_PX) return 0
  return Math.min(height, windowHeight)
}

/**
 * Bottom padding that keeps content clear of the software keyboard on iOS.
 *
 * Replaces `KeyboardAvoidingView` for full-height screens: same keyboard
 * events and layout animation, but the inset is validated against the window
 * (see `keyboardInsetFromMetrics`) instead of a measured frame, so a bogus
 * launch-time frame reads as "no keyboard" rather than "keyboard everywhere".
 * Android resizes the window itself, so the inset is always 0 there.
 */
export function useKeyboardInset(): number {
  const { height: windowHeight } = useWindowDimensions()
  const [inset, setInset] = useState(0)

  useEffect(() => {
    if (Platform.OS !== 'ios') return

    const apply = (next: number, event?: KeyboardEvent) => {
      setInset((current) => {
        if (current === next) return current
        const duration = event?.duration ?? 0
        if (duration > 0) {
          LayoutAnimation.configureNext({
            duration: Math.max(duration, 10),
            update: {
              duration: Math.max(duration, 10),
              type: LayoutAnimation.Types[event?.easing ?? 'keyboard'] ?? 'keyboard',
            },
          })
        }
        return next
      })
    }

    const show = Keyboard.addListener(SHOW_EVENT, (event) =>
      apply(keyboardInsetFromMetrics(event.endCoordinates, windowHeight), event),
    )
    const hide = Keyboard.addListener(HIDE_EVENT, (event) => apply(0, event))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [windowHeight])

  return inset
}
