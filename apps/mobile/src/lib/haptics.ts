import { AppState } from 'react-native'
import * as Haptics from 'expo-haptics'

function runWhenActive(action: () => Promise<void>) {
  if (AppState.currentState !== 'active') return
  void action().catch(() => {
    // Haptics are a best-effort enhancement. They must never affect navigation
    // or the conversation when the native device capability is unavailable.
  })
}

export function triggerThreadSelectionHaptic() {
  runWhenActive(() => Haptics.selectionAsync())
}

export function triggerAgentCompletionHaptic() {
  runWhenActive(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light))
}
