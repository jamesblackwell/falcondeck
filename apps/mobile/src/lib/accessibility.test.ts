import { AccessibilityInfo, Platform } from 'react-native'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { announceAgentCompletion } from './accessibility'

describe('mobile accessibility announcements', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    Platform.OS = 'ios'
  })

  it('queues the completion announcement behind current VoiceOver speech', () => {
    const announce = vi.spyOn(
      AccessibilityInfo,
      'announceForAccessibilityWithOptions',
    )

    announceAgentCompletion()

    expect(announce).toHaveBeenCalledWith('Response complete', { queue: true })
  })

  it('uses the cross-platform announcement on Android', () => {
    Platform.OS = 'android'
    const announce = vi.spyOn(AccessibilityInfo, 'announceForAccessibility')

    announceAgentCompletion()

    expect(announce).toHaveBeenCalledWith('Response complete')
  })
})
