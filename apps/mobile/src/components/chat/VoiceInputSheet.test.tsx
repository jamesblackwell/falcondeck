import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  useRelayStore,
} from '@/store/relay-store'

import { VoiceInputSheet } from './VoiceInputSheet'

describe('VoiceInputSheet', () => {
  const originalCallRpc = useRelayStore.getState()._callRpc

  beforeEach(async () => {
    vi.clearAllMocks()
    resetSpeechSettings()
    clearPendingVoiceRecording()
    useRelayStore.getState()._callRpc = vi
      .fn()
      .mockResolvedValue({ configured: true, storage: 'os_credential_store' }) as typeof originalCallRpc
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

  afterEach(() => {
    useRelayStore.getState()._callRpc = originalCallRpc
  })
})
