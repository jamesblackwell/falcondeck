import { beforeEach, describe, expect, it, vi } from 'vitest'

import { setJson, storage } from '@/storage/mmkv'

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

  it('migrates the original high-accuracy default to the faster model', () => {
    setJson('fd.speechSettings.v1', {
      provider: 'openrouter',
      model: 'openai/gpt-transcribe',
      language: null,
    })

    expect(getSpeechSettings().model).toBe(DEFAULT_OPENROUTER_STT_MODEL)
  })

  it('upgrades the old whisper default from v1 but keeps deliberate picks', () => {
    setJson('fd.speechSettings.v1', {
      provider: 'openrouter',
      model: 'openai/whisper-large-v3-turbo',
      language: 'en',
    })
    const migrated = getSpeechSettings()
    expect(migrated.model).toBe(DEFAULT_OPENROUTER_STT_MODEL)
    expect(migrated.language).toBe('en')

    // A model picked explicitly (stored under v2) sticks, even if it was once
    // a shipped default.
    updateSpeechSettings({ model: 'openai/whisper-large-v3-turbo' })
    expect(getSpeechSettings().model).toBe('openai/whisper-large-v3-turbo')
  })

  it('keeps a failed recording available for a later retry', () => {
    const pending = setPendingVoiceRecording('file:///voice.m4a', 'openrouter')
    expect(getPendingVoiceRecording()).toEqual(pending)
    clearPendingVoiceRecording()
    expect(getPendingVoiceRecording()).toBeNull()
  })

  it('migrates recordings saved before provider tracking to the selected mode', () => {
    updateSpeechSettings({ provider: 'on-device' })
    setJson('fd.pendingVoiceRecording.v1', {
      uri: 'file:///legacy.m4a',
      createdAt: 123,
    })

    expect(getPendingVoiceRecording()).toEqual({
      uri: 'file:///legacy.m4a',
      createdAt: 123,
      provider: 'on-device',
    })

    updateSpeechSettings({ provider: 'openrouter' })
    expect(getPendingVoiceRecording()?.provider).toBe('on-device')
  })

  it('keeps a speech choice active when device storage rejects the write', () => {
    const set = vi.spyOn(storage, 'set').mockImplementation(() => {
      throw new Error('MMKV is unavailable')
    })
    try {
      expect(() => updateSpeechSettings({ provider: 'on-device' })).not.toThrow()
      expect(getSpeechSettings().provider).toBe('on-device')
    } finally {
      set.mockRestore()
    }
  })
})
