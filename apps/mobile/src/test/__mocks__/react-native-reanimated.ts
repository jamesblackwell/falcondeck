// Stub reanimated for tests
import { useState } from 'react'

export const View = 'Animated.View'
// Referentially stable across renders, like the real hook — components use
// shared values in effect dep arrays, and a fresh object per render would
// re-fire those effects in tests only.
export function useSharedValue(init: any) {
  const [shared] = useState(() => ({ value: init }))
  return shared
}
export function cancelAnimation() {}
export function useAnimatedStyle(fn: any) { return fn() }
export function useDerivedValue(fn: any) { return { value: fn() } }
export function useAnimatedScrollHandler() { return () => {} }
export function useAnimatedKeyboard() {
  return { height: { value: 0 }, state: { value: 0 } }
}
export function withTiming(val: any) { return val }
export function withRepeat(val: any) { return val }
export function withSequence(...vals: any[]) { return vals[0] }
export function withDelay(_delay: any, val: any) { return val }
export const Easing = {
  out: (fn: any) => fn,
  cubic: (t: any) => t,
  linear: (t: any) => t,
}
export const KeyboardState = { OPEN: 1, CLOSED: 0 }
const Animated = {
  View,
  createAnimatedComponent: (c: any) => c,
}

export default Animated
