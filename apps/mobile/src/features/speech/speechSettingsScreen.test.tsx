import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { renderComponent } from '@/test/render'
import {
  resetSpeechSettings,
  updateSpeechSettings,
} from '@/features/speech/speechSettings'
import { useRelayStore } from '@/store/relay-store'

// Lives here rather than beside the route: every file under src/app is a
// route to expo-router's require.context, so a test module there gets bundled
// into the app and its vitest import crashes the dev client at startup.
import SpeechSettingsScreen from '@/app/(app)/settings/speech'

describe('SpeechSettingsScreen', () => {
  const originalCallRpc = useRelayStore.getState()._callRpc

  beforeEach(() => {
    resetSpeechSettings()
    updateSpeechSettings({ provider: 'openrouter' })
  })

  afterEach(() => {
    useRelayStore.getState()._callRpc = originalCallRpc
  })

  it('shows a retry action when the desktop check fails and recovers on press', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('desktop unavailable'))
    useRelayStore.getState()._callRpc = rpc as typeof originalCallRpc
    const rendered = renderComponent(<SpeechSettingsScreen />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const failedRow = rendered.root.findByProps({
      label: 'API key',
    })
    expect(failedRow.props.detail).toBe(
      'Could not check desktop. Tap to retry.',
    )

    rpc.mockImplementation((method: string) =>
      Promise.resolve(
        method === 'speech.status'
          ? { configured: true, storage: 'daemon_secret_store' }
          : [{ id: 'openai/gpt-transcribe', name: 'GPT Transcribe' }],
      ),
    )
    await act(async () => {
      failedRow.props.onPress()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(
      rendered.root.findByProps({ label: 'API key' }).props.value,
    ).toBe('Ready')
    expect(rendered.root.findByProps({ label: 'Model' }).props.detail).toBe(
      '1 model available',
    )
  })
})
