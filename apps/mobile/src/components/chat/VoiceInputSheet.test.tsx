import { act } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio'

import { renderComponent } from '@/test/render'
import {
  clearPendingVoiceRecording,
  resetSpeechSettings,
} from '@/features/speech/speechSettings'
import {
  clearOpenRouterApiKey,
  persistOpenRouterApiKey,
} from '@/storage/secure'

import { VoiceInputSheet } from './VoiceInputSheet'

describe('VoiceInputSheet', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    resetSpeechSettings()
    clearPendingVoiceRecording()
    await clearOpenRouterApiKey()
  })

  it('does not start cloud recording after the sheet is dismissed during permission startup', async () => {
    let resolvePermission!: (value: { granted: boolean }) => void
    const permission = new Promise<{ granted: boolean }>((resolve) => {
      resolvePermission = resolve
    })
    vi.mocked(requestRecordingPermissionsAsync).mockReturnValueOnce(
      permission as ReturnType<typeof requestRecordingPermissionsAsync>,
    )
    await persistOpenRouterApiKey('test-key')
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
})
