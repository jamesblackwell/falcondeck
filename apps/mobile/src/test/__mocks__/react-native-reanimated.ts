// Stub reanimated for tests
import { useState } from 'react'

export const View = 'Animated.View'
// Referentially stable across renders, like the real hook — components use
// shared values in effect dep arrays, and a fresh object per render would
// re-fire those effects in tests only.
export function useSharedValue(init: any) {
  const [shared] = useState(() => {
    const value: { value: any; get: () => any; set: (next: any) => void } = {
      value: init,
      get: () => value.value,
      set: (next) => { value.value = next },
    }
    return value
  })
  return shared
}
export function cancelAnimation() {}
export function useAnimatedStyle(fn: any) { return fn() }
export function useDerivedValue(fn: any) { return { value: fn() } }
export function useAnimatedScrollHandler() { return () => {} }
export function useAnimatedKeyboard() {
  return { height: { value: 0 }, state: { value: 0 } }
}
let reducedMotion = false
export function useReducedMotion() { return reducedMotion }
export function __setReducedMotionForTests(value: boolean) { reducedMotion = value }
export function withTiming(val: any) { return val }
export function withRepeat(val: any) { return val }
export function withSequence(...vals: any[]) { return vals[0] }
export function withDelay(_delay: any, val: any) { return val }
export function interpolate(value: number, input: number[], output: number[]) {
  const upperIndex = input.findIndex((point) => point >= value)
  if (upperIndex <= 0) return output[0]
  if (upperIndex === -1) return output[output.length - 1]

  const lowerIndex = upperIndex - 1
  const position = (value - input[lowerIndex]) / (input[upperIndex] - input[lowerIndex])
  return output[lowerIndex] + position * (output[upperIndex] - output[lowerIndex])
}
export const Easing = {
  out: (fn: any) => fn,
  cubic: (t: any) => t,
  linear: (t: any) => t,
}
export const KeyboardState = { OPEN: 1, CLOSED: 0 }
// Layout animation builders are chainable in the real library; components pass
// the built descriptor straight to Animated.View, so any object will do.
function layoutAnimationBuilder() {
  const builder: any = {}
  for (const method of ['duration', 'delay', 'easing', 'springify', 'withInitialValues', 'build']) {
    builder[method] = () => builder
  }
  return builder
}
export const FadeIn = layoutAnimationBuilder()
export const FadeOut = layoutAnimationBuilder()
export const LinearTransition = layoutAnimationBuilder()
const Animated = {
  View,
  createAnimatedComponent: (c: any) => c,
}

export default Animated
