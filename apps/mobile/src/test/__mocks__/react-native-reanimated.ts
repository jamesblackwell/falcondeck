// Stub reanimated for tests
export function useSharedValue(init: any) { return { value: init } }
export function useAnimatedStyle(fn: any) { return fn() }
export function useAnimatedScrollHandler() { return () => {} }
export function useAnimatedKeyboard() {
  return { height: { value: 0 }, state: { value: 0 } }
}
export function withTiming(val: any) { return val }
export function withRepeat(val: any) { return val }
export function withSequence(...vals: any[]) { return vals[0] }
export const KeyboardState = { OPEN: 1, CLOSED: 0 }
export default {
  View: 'Animated.View',
  createAnimatedComponent: (c: any) => c,
}
