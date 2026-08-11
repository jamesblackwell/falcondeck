import { AccessibilityInfo, Platform } from 'react-native'

/** Announces a foreground turn completion without coupling accessibility to
 * recycled message rows. Queue on iOS so VoiceOver does not cut off speech the
 * user is already hearing; Android uses the cross-platform announcement API. */
export function announceAgentCompletion() {
  if (Platform.OS === 'ios') {
    AccessibilityInfo.announceForAccessibilityWithOptions(
      'Response complete',
      { queue: true },
    )
    return
  }

  AccessibilityInfo.announceForAccessibility('Response complete')
}
