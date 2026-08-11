import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as Haptics from 'expo-haptics'
import { AppState } from 'react-native'

import {
  triggerAgentCompletionHaptic,
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

  it('does not vibrate while the app is inactive', () => {
    AppState.currentState = 'background'
    const selectionAsync = vi.spyOn(Haptics, 'selectionAsync')
    const impactAsync = vi.spyOn(Haptics, 'impactAsync')

    triggerThreadSelectionHaptic()
    triggerAgentCompletionHaptic()

    expect(selectionAsync).not.toHaveBeenCalled()
    expect(impactAsync).not.toHaveBeenCalled()
  })
})
