// Minimal React Native mock for Vitest (store/logic tests only)
export const Platform = { OS: 'ios', select: (opts: any) => opts.ios ?? opts.default }
export const View = 'View'
export const Text = 'Text'
export const Pressable = 'Pressable'
export const TextInput = 'TextInput'
export const ScrollView = 'ScrollView'
export const KeyboardAvoidingView = 'KeyboardAvoidingView'
export const ActivityIndicator = 'ActivityIndicator'
export const Switch = 'Switch'
export const Modal = 'Modal'
export const FlatList = 'FlatList'
export const useWindowDimensions = () => ({ width: 402, height: 874, scale: 3, fontScale: 1 })
export const AppState = {
  currentState: 'active',
  addEventListener: () => ({ remove: () => {} }),
}
export const Keyboard = { addListener: () => ({ remove: () => {} }) }
export const Appearance = {
  getColorScheme: () => 'light' as const,
  setColorScheme: (_scheme: 'light' | 'dark' | null) => {},
  addChangeListener: () => ({ remove: () => {} }),
}
export const Alert = {
  alert: () => {},
  prompt: () => {},
}
export const Linking = { openURL: async () => {} }
export const AccessibilityInfo = {
  announceForAccessibility: (_announcement: string) => {},
  announceForAccessibilityWithOptions: (
    _announcement: string,
    _options: { queue?: boolean },
  ) => {},
}
export const StyleSheet = { create: (styles: any) => styles }
export const Animated = {
  View: 'Animated.View',
  Value: class {
    value: number
    constructor(value: number) {
      this.value = value
    }
    setValue(value: number) {
      this.value = value
    }
  },
  spring: (_value: unknown, _config: unknown) => ({
    start: (callback?: () => void) => callback?.(),
  }),
  timing: (_value: unknown, _config: unknown) => ({
    start: (callback?: () => void) => callback?.(),
  }),
}
// Returns the config as panHandlers so tests can invoke the gesture
// callbacks (onPanResponderRelease etc.) directly off the rendered props.
export const PanResponder = {
  create: (config: Record<string, unknown>) => ({ panHandlers: config }),
}
