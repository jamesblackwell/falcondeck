import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio'
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition'

import { renderComponent } from '@/test/render'
import {
  clearPendingVoiceRecording,
  getPendingVoiceRecording,
  resetSpeechSettings,
  setPendingVoiceRecording,
  updateSpeechSettings,
} from '@/features/speech/speechSettings'
import { useRelayStore } from '@/store/relay-store'

import { VoiceInputSheet } from './VoiceInputSheet'

describe('VoiceInputSheet', () => {
  const originalCallRpc = useRelayStore.getState()._callRpc

  beforeEach(async () => {
    vi.clearAllMocks()
    resetSpeechSettings()
    clearPendingVoiceRecording()
    useRelayStore.getState()._callRpc = vi.fn().mockResolvedValue({
      configured: true,
      storage: 'os_credential_store',
    }) as typeof originalCallRpc
  })

  it('does not start cloud recording after the sheet is dismissed during permission startup', async () => {
    let resolvePermission!: (value: { granted: boolean }) => void
    const permission = new Promise<{ granted: boolean }>((resolve) => {
      resolvePermission = resolve
    })
    vi.mocked(requestRecordingPermissionsAsync).mockReturnValueOnce(
      permission as ReturnType<typeof requestRecordingPermissionsAsync>,
    )
    const onClose = vi.fn()
    const r = renderComponent(
      <VoiceInputSheet onTranscript={vi.fn()} onClose={onClose} />,
    )

    act(() => {
      r.root
        .findByProps({
          accessibilityLabel: 'Set up OpenRouter speech recognition',
        })
        .props.onPress()
    })
    await act(async () => {
      await Promise.resolve()
    })
    act(() => {
      r.root
        .findAllByProps({ accessibilityLabel: 'Close voice input' })
        .find((node) => typeof node.props.onPress === 'function')
        ?.props.onPress()
    })
    await act(async () => {
      resolvePermission({ granted: true })
      await permission
    })

    expect(setAudioModeAsync).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('retries an on-device recording locally without requesting microphone access', async () => {
    updateSpeechSettings({ provider: 'on-device' })
    setPendingVoiceRecording('file:///saved-voice.wav', 'on-device')
    const r = renderComponent(
      <VoiceInputSheet onTranscript={vi.fn()} onClose={vi.fn()} />,
    )

    await act(async () => {
      r.root.findByProps({ label: 'Retry transcription' }).props.onPress()
      await Promise.resolve()
    })

    expect(
      ExpoSpeechRecognitionModule.requestMicrophonePermissionsAsync,
    ).not.toHaveBeenCalled()
    expect(ExpoSpeechRecognitionModule.start).toHaveBeenCalledWith(
      expect.objectContaining({
        requiresOnDeviceRecognition: true,
        audioSource: expect.objectContaining({
          uri: 'file:///saved-voice.wav',
        }),
      }),
    )
    expect(useRelayStore.getState()._callRpc).not.toHaveBeenCalled()
  })

  it('does not send a saved OpenRouter recording when the desktop key is missing', async () => {
    updateSpeechSettings({ provider: 'openrouter' })
    setPendingVoiceRecording('file:///saved-voice.m4a', 'openrouter')
    const callRpc = vi.fn().mockResolvedValue({
      configured: false,
      storage: 'os_credential_store',
    })
    useRelayStore.getState()._callRpc = callRpc as typeof originalCallRpc
    const r = renderComponent(
      <VoiceInputSheet onTranscript={vi.fn()} onClose={vi.fn()} />,
    )

    await act(async () => {
      r.root.findByProps({ label: 'Retry transcription' }).props.onPress()
      await Promise.resolve()
    })

    expect(callRpc).toHaveBeenCalledWith(
      'speech.status',
      {},
      { timeoutMs: 8_000 },
    )
    expect(callRpc).not.toHaveBeenCalledWith(
      'speech.transcribe',
      expect.anything(),
      expect.anything(),
    )
    expect(getPendingVoiceRecording()).toMatchObject({
      uri: 'file:///saved-voice.m4a',
      provider: 'openrouter',
    })
  })

  it('offers a clean on-device recording when an older cloud draft is blocking it', async () => {
    updateSpeechSettings({ provider: 'on-device' })
    setPendingVoiceRecording('file:///saved-voice.m4a', 'openrouter')
    const r = renderComponent(
      <VoiceInputSheet onTranscript={vi.fn()} onClose={vi.fn()} />,
    )

    await act(async () => {
      r.root
        .findByProps({ label: 'Discard and record on-device' })
        .props.onPress()
      await Promise.resolve()
    })

    expect(getPendingVoiceRecording()).toBeNull()
    expect(ExpoSpeechRecognitionModule.start).toHaveBeenCalledWith(
      expect.objectContaining({
        requiresOnDeviceRecognition: true,
        audioSource: undefined,
      }),
    )
    expect(useRelayStore.getState()._callRpc).not.toHaveBeenCalled()
  })

  afterEach(() => {
    useRelayStore.getState()._callRpc = originalCallRpc
  })
})
