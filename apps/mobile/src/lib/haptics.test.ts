import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as Haptics from 'expo-haptics'
import { AppState } from 'react-native'

import {
  triggerAgentCompletionHaptic,
  triggerComposerSelectionHaptic,
  triggerComposerStopHaptic,
  triggerComposerTapHaptic,
  triggerThreadArchiveFailedHaptic,
  triggerThreadArchiveHaptic,
  triggerThreadSelectionHaptic,
} from './haptics'

describe('mobile haptics', () => {
  beforeEach(() => {
    AppState.currentState = 'active'
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses selection feedback for thread navigation', () => {
    const selectionAsync = vi.spyOn(Haptics, 'selectionAsync')

    triggerThreadSelectionHaptic()

    expect(selectionAsync).toHaveBeenCalledOnce()
  })

  it('uses a light impact when an agent turn completes', () => {
    const impactAsync = vi.spyOn(Haptics, 'impactAsync')

    triggerAgentCompletionHaptic()

    expect(impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light)
  })

  it('uses a medium impact when a thread is archived', () => {
    const impactAsync = vi.spyOn(Haptics, 'impactAsync')

    triggerThreadArchiveHaptic()

    expect(impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium)
  })

  it('uses error notification when an optimistic archive is rolled back', () => {
    const notificationAsync = vi.spyOn(Haptics, 'notificationAsync')

    triggerThreadArchiveFailedHaptic()

    expect(notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Error,
    )
  })

  it('uses selection feedback when a composer control opens a menu', () => {
    const selectionAsync = vi.spyOn(Haptics, 'selectionAsync')

    triggerComposerSelectionHaptic()

    expect(selectionAsync).toHaveBeenCalledOnce()
  })

  it('uses a light impact when a composer button confirms a tap', () => {
    const impactAsync = vi.spyOn(Haptics, 'impactAsync')

    triggerComposerTapHaptic()

    expect(impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light)
  })

  it('uses a medium impact when a composer stop button is tapped', () => {
    const impactAsync = vi.spyOn(Haptics, 'impactAsync')

    triggerComposerStopHaptic()

    expect(impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium)
  })

  it('does not vibrate while the app is inactive', () => {
    AppState.currentState = 'background'
    const selectionAsync = vi.spyOn(Haptics, 'selectionAsync')
    const impactAsync = vi.spyOn(Haptics, 'impactAsync')
    const notificationAsync = vi.spyOn(Haptics, 'notificationAsync')

    triggerThreadSelectionHaptic()
    triggerAgentCompletionHaptic()
    triggerThreadArchiveHaptic()
    triggerThreadArchiveFailedHaptic()
    triggerComposerSelectionHaptic()
    triggerComposerTapHaptic()
    triggerComposerStopHaptic()

    expect(selectionAsync).not.toHaveBeenCalled()
    expect(impactAsync).not.toHaveBeenCalled()
    expect(notificationAsync).not.toHaveBeenCalled()
  })
})
