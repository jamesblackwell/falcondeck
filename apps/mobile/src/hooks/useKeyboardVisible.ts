import { useEffect, useState } from 'react'
import { Keyboard, Platform } from 'react-native'

// iOS fires the `Will` pair ahead of the animation, so the layout settles in
// step with the keyboard instead of a frame behind it. Android only has `Did`.
const SHOW_EVENT = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
const HIDE_EVENT = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'

/**
 * Whether the software keyboard is on screen.
 *
 * Needed because the home-indicator inset and the keyboard occupy the same
 * space: KeyboardAvoidingView already lifts content clear of the keyboard, so
 * anything that also pads by `insets.bottom` leaves a dead gap once the
 * keyboard is up.
 */
export function useKeyboardVisible(): boolean {
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    const show = Keyboard.addListener(SHOW_EVENT, () => setIsVisible(true))
    const hide = Keyboard.addListener(HIDE_EVENT, () => setIsVisible(false))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])

  return isVisible
}
