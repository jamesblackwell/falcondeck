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

export function triggerMessageAcceptedHaptic() {
  runWhenActive(() =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  )
}

export function triggerMessageFailedHaptic() {
  runWhenActive(() =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
  )
}

export function triggerThreadArchiveHaptic() {
  runWhenActive(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium))
}

export function triggerThreadArchiveFailedHaptic() {
  runWhenActive(() =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
  )
}

export function triggerComposerSelectionHaptic() {
  runWhenActive(() => Haptics.selectionAsync())
}

export function triggerComposerTapHaptic() {
  runWhenActive(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light))
}

export function triggerComposerStopHaptic() {
  runWhenActive(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium))
}
