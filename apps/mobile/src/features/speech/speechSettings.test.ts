import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearPendingVoiceRecording,
  DEFAULT_OPENROUTER_STT_MODEL,
  getPendingVoiceRecording,
  getSpeechSettings,
  resetSpeechSettings,
  setPendingVoiceRecording,
  updateSpeechSettings,
} from './speechSettings'

describe('speech settings', () => {
  beforeEach(() => {
    resetSpeechSettings()
    clearPendingVoiceRecording()
  })

  it('uses safe defaults and persists provider/model selection', () => {
    expect(getSpeechSettings()).toEqual({
      provider: null,
      model: DEFAULT_OPENROUTER_STT_MODEL,
      language: null,
    })

    updateSpeechSettings({ provider: 'openrouter', model: 'deepgram/nova-3' })
    expect(getSpeechSettings()).toMatchObject({
      provider: 'openrouter',
      model: 'deepgram/nova-3',
    })
  })

  it('keeps a failed recording available for a later retry', () => {
    const pending = setPendingVoiceRecording('file:///voice.m4a')
    expect(getPendingVoiceRecording()).toEqual(pending)
    clearPendingVoiceRecording()
    expect(getPendingVoiceRecording()).toBeNull()
  })
})
