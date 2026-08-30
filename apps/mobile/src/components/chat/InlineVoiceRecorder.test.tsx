import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio'
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition'

import { renderComponent, textOf } from '@/test/render'
import {
  clearPendingVoiceRecording,
  getPendingVoiceRecording,
  resetSpeechSettings,
  setPendingVoiceRecording,
  updateSpeechSettings,
} from '@/features/speech/speechSettings'
import { transcriptionRetry } from '@/features/speech/openRouterTranscription'
import {
  speechLiveActivity,
  type SpeechActivityActionListener,
} from '@/features/speech/speechLiveActivity'
import { useRelayStore } from '@/store/relay-store'

import { InlineVoiceRecorder } from './InlineVoiceRecorder'

describe('InlineVoiceRecorder', () => {
  const originalCallRpc = useRelayStore.getState()._callRpc
  const originalWait = transcriptionRetry.wait

  beforeEach(async () => {
    vi.clearAllMocks()
    resetSpeechSettings()
    clearPendingVoiceRecording()
    transcriptionRetry.wait = vi.fn(async () => {})
    useRelayStore.getState()._callRpc = vi.fn().mockResolvedValue({
      configured: true,
      storage: 'daemon_secret_store',
    }) as typeof originalCallRpc
  })

  it('does not start cloud recording after cancelling during permission startup', async () => {
    let resolvePermission!: (value: { granted: boolean }) => void
    const permission = new Promise<{ granted: boolean }>((resolve) => {
      resolvePermission = resolve
    })
    vi.mocked(requestRecordingPermissionsAsync).mockReturnValueOnce(
      permission as ReturnType<typeof requestRecordingPermissionsAsync>,
    )
    const onClose = vi.fn()
    const r = renderComponent(
      <InlineVoiceRecorder
        provider="openrouter"
        onTranscript={vi.fn()}
        onClose={onClose}
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })
    act(() => {
      r.root
        .findByProps({ accessibilityLabel: 'Cancel voice input' })
        .props.onPress()
    })
    await act(async () => {
      resolvePermission({ granted: true })
      await permission
    })

    expect(setAudioModeAsync).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('starts cloud recording without waiting for the desktop', async () => {
    updateSpeechSettings({ provider: 'openrouter' })
    const startListening = vi.spyOn(speechLiveActivity, 'startListening')
    useRelayStore.getState()._callRpc = vi.fn(
      () => new Promise(() => {}),
    ) as unknown as typeof originalCallRpc

    const r = renderComponent(
      <InlineVoiceRecorder
        provider="openrouter"
        onTranscript={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(useRelayStore.getState()._callRpc).not.toHaveBeenCalled()
    expect(requestRecordingPermissionsAsync).toHaveBeenCalledTimes(1)
    expect(setAudioModeAsync).toHaveBeenCalledWith({
      allowsRecording: true,
      allowsBackgroundRecording: true,
      playsInSilentMode: true,
    })
    expect(startListening).toHaveBeenCalledTimes(1)
    expect(
      r.root.findByProps({ accessibilityLabel: 'Stop and transcribe' }).props
        .accessibilityState,
    ).toEqual({ disabled: false })
  })

  it('surfaces an on-device permission failure instead of leaving startup pending', async () => {
    updateSpeechSettings({ provider: 'on-device' })
    const requestPermission = vi.mocked(
      ExpoSpeechRecognitionModule.requestMicrophonePermissionsAsync,
    )
    type SpeechPermission = Awaited<ReturnType<typeof requestPermission>>
    const grantedPermission = {
      status: 'granted',
      expires: 'never',
      granted: true,
      canAskAgain: true,
    } as SpeechPermission
    let rejectPermission!: (error: Error) => void
    const pendingPermission = new Promise<SpeechPermission>((_resolve, reject) => {
      rejectPermission = reject
    })
    requestPermission.mockReturnValue(pendingPermission)

    const r = renderComponent(
      <InlineVoiceRecorder
        provider="on-device"
        onTranscript={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    try {
      await act(async () => {
        expect(requestPermission).toHaveBeenCalledOnce()
        rejectPermission(new Error('Speech permission service failed'))
        await pendingPermission.catch(() => undefined)
      })
      expect(textOf(r)).toContain('Speech permission service failed')
    } finally {
      requestPermission.mockResolvedValue(grantedPermission)
    }
  })

  it('stops and transcribes only once when the stop control is tapped twice', async () => {
    updateSpeechSettings({ provider: 'openrouter' })
    useRelayStore.getState()._callRpc = vi.fn(async () => ({
      text: 'only once',
      model: 'whisper',
    })) as unknown as typeof originalCallRpc
    const r = renderComponent(
      <InlineVoiceRecorder
        provider="openrouter"
        onTranscript={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    const recorder = vi.mocked(useAudioRecorder).mock.results.at(-1)?.value
    const stop = vi.mocked(recorder.stop)
    const control = r.root.findByProps({ accessibilityLabel: 'Stop and transcribe' })

    await act(async () => {
      const first = control.props.onPress()
      const second = control.props.onPress()
      await Promise.all([first, second])
    })

    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('can stop a fresh recording after discarding a failed transcription', async () => {
    updateSpeechSettings({ provider: 'openrouter' })
    useRelayStore.getState()._callRpc = vi.fn(async (method: string) => {
      if (method === 'speech.status') {
        return { configured: true, storage: 'daemon_secret_store' }
      }
      throw new Error('OpenRouter is not configured')
    }) as unknown as typeof originalCallRpc
    const r = renderComponent(
      <InlineVoiceRecorder
        provider="openrouter"
        onTranscript={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    const recorder = vi.mocked(useAudioRecorder).mock.results.at(-1)?.value
    const stop = vi.mocked(recorder.stop)

    await act(async () => {
      await r.root
        .findByProps({ accessibilityLabel: 'Stop and transcribe' })
        .props.onPress()
    })
    expect(textOf(r)).toContain('OpenRouter is not configured')

    await act(async () => {
      r.root
        .findByProps({
          accessibilityLabel: 'Discard recording and record again',
        })
        .props.onPress()
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      await r.root
        .findByProps({ accessibilityLabel: 'Stop and transcribe' })
        .props.onPress()
    })

    expect(stop).toHaveBeenCalledTimes(2)
  })

  it('deactivates recording audio even when cancellation cannot stop the recorder', async () => {
    updateSpeechSettings({ provider: 'openrouter' })
    const r = renderComponent(
      <InlineVoiceRecorder
        provider="openrouter"
        onTranscript={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    const recorder = vi.mocked(useAudioRecorder).mock.results.at(-1)?.value
    vi.mocked(recorder.stop).mockRejectedValueOnce(new Error('Recorder stop failed'))

    act(() => {
      r.root.findByProps({ accessibilityLabel: 'Cancel voice input' }).props.onPress()
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(setAudioModeAsync).toHaveBeenCalledWith({
      allowsRecording: false,
      allowsBackgroundRecording: false,
    })
  })

  it('marks the arrow control as a send and the square as an edit', async () => {
    updateSpeechSettings({ provider: 'openrouter' })
    useRelayStore.getState()._callRpc = vi.fn(async (method: string) =>
      method === 'speech.status'
        ? { configured: true, storage: 'daemon_secret_store' }
        : { text: 'ship it', model: 'whisper' },
    ) as unknown as typeof originalCallRpc
    const onTranscript = vi.fn()
    const r = renderComponent(
      <InlineVoiceRecorder
        provider="openrouter"
        onTranscript={onTranscript}
        onClose={vi.fn()}
      />,
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      await r.root
        .findByProps({ accessibilityLabel: 'Transcribe and send' })
        .props.onPress()
    })

    expect(onTranscript).toHaveBeenCalledWith('ship it', { submit: true })
  })

  it('keeps a stopped recording in the composer to edit', async () => {
    updateSpeechSettings({ provider: 'openrouter' })
    const setActivityMode = vi.spyOn(speechLiveActivity, 'setMode')
    const endActivity = vi.spyOn(speechLiveActivity, 'end')
    useRelayStore.getState()._callRpc = vi.fn(async (method: string) =>
      method === 'speech.status'
        ? { configured: true, storage: 'daemon_secret_store' }
        : { text: 'ship it', model: 'whisper' },
    ) as unknown as typeof originalCallRpc
    const onTranscript = vi.fn()
    const r = renderComponent(
      <InlineVoiceRecorder
        provider="openrouter"
        onTranscript={onTranscript}
        onClose={vi.fn()}
      />,
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      await r.root
        .findByProps({ accessibilityLabel: 'Stop and transcribe' })
        .props.onPress()
    })

    expect(onTranscript).toHaveBeenCalledWith('ship it', { submit: false })
    expect(setActivityMode).toHaveBeenCalledWith('transcribing')
    expect(endActivity).toHaveBeenCalled()
  })

  it('finishes an active recording from the Lock Screen control', async () => {
    updateSpeechSettings({ provider: 'openrouter' })
    let activityAction: SpeechActivityActionListener = () => {}
    vi.spyOn(speechLiveActivity, 'subscribeAction').mockImplementation(
      (listener) => {
        activityAction = listener
        return vi.fn()
      },
    )
    useRelayStore.getState()._callRpc = vi.fn(async (method: string) =>
      method === 'speech.status'
        ? { configured: true, storage: 'daemon_secret_store' }
        : { text: 'from the lock screen', model: 'whisper' },
    ) as unknown as typeof originalCallRpc
    const onTranscript = vi.fn()
    renderComponent(
      <InlineVoiceRecorder
        provider="openrouter"
        onTranscript={onTranscript}
        onClose={vi.fn()}
      />,
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      activityAction('finish-recording')
      await vi.waitFor(() => expect(onTranscript).toHaveBeenCalled())
    })

    expect(onTranscript).toHaveBeenCalledWith('from the lock screen', {
      submit: false,
    })
  })

  it('retries an on-device recording locally without requesting microphone access', async () => {
    updateSpeechSettings({ provider: 'on-device' })
    setPendingVoiceRecording('file:///saved-voice.wav', 'on-device')
    const r = renderComponent(
      <InlineVoiceRecorder
        provider="on-device"
        onTranscript={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await act(async () => {
      r.root
        .findByProps({ accessibilityLabel: 'Retry transcription' })
        .props.onPress()
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
      storage: 'daemon_secret_store',
    })
    useRelayStore.getState()._callRpc = callRpc as typeof originalCallRpc
    const r = renderComponent(
      <InlineVoiceRecorder
        provider="openrouter"
        onTranscript={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await act(async () => {
      r.root
        .findByProps({ accessibilityLabel: 'Retry transcription' })
        .props.onPress()
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

  it('discards a blocking cloud draft and records fresh on-device', async () => {
    updateSpeechSettings({ provider: 'on-device' })
    setPendingVoiceRecording('file:///saved-voice.m4a', 'openrouter')
    const r = renderComponent(
      <InlineVoiceRecorder
        provider="on-device"
        onTranscript={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await act(async () => {
      r.root
        .findByProps({
          accessibilityLabel: 'Discard recording and record again',
        })
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

  it('retries a dropped cloud transcription and shows the attempt', async () => {
    updateSpeechSettings({ provider: 'openrouter' })
    setPendingVoiceRecording('file:///saved-voice.m4a', 'openrouter')
    let transcribeCalls = 0
    let resolveSecond!: (value: { text: string; model: string }) => void
    const secondAttempt = new Promise<{ text: string; model: string }>(
      (resolve) => {
        resolveSecond = resolve
      },
    )
    const callRpc = vi.fn(async (method: string) => {
      if (method === 'speech.status') {
        return { configured: true, storage: 'daemon_secret_store' }
      }
      transcribeCalls += 1
      if (transcribeCalls === 1) {
        throw new Error('Lost the relay connection')
      }
      return secondAttempt
    })
    useRelayStore.getState()._callRpc = callRpc as typeof originalCallRpc
    const r = renderComponent(
      <InlineVoiceRecorder
        provider="openrouter"
        onTranscript={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await act(async () => {
      r.root
        .findByProps({ accessibilityLabel: 'Retry transcription' })
        .props.onPress()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(textOf(r)).toContain('Retrying (2)')
    expect(
      r.root.findByProps({
        accessibilityLabel: 'Retrying transcription, attempt 2',
      }),
    ).toBeTruthy()

    await act(async () => {
      resolveSecond({ text: 'ship it', model: 'whisper' })
      await secondAttempt
    })
  })

  afterEach(() => {
    transcriptionRetry.wait = originalWait
    useRelayStore.getState()._callRpc = originalCallRpc
    vi.restoreAllMocks()
  })
})
