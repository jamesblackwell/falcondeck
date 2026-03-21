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
export const AppState = {
  currentState: 'active',
  addEventListener: () => ({ remove: () => {} }),
}
export const Keyboard = { addListener: () => ({ remove: () => {} }) }
export const Linking = { openURL: async () => {} }
export const StyleSheet = { create: (styles: any) => styles }
