import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  fetchOpenRouterSpeechModels,
  getDesktopSpeechStatus,
  transcribeWithDesktopOpenRouter,
} from './openRouterTranscription'
import { useRelayStore } from '@/store/relay-store'

describe('OpenRouter transcription', () => {
  const originalCallRpc = useRelayStore.getState()._callRpc

  afterEach(() => {
    vi.unstubAllGlobals()
    useRelayStore.getState()._callRpc = originalCallRpc
  })

  it('discovers and sorts transcription models', async () => {
    const rpc = vi.fn().mockResolvedValue([
      { id: 'a/model', name: 'Alpha' },
      { id: 'z/model', name: 'Zulu' },
    ])
    useRelayStore.getState()._callRpc = rpc as typeof originalCallRpc

    await expect(fetchOpenRouterSpeechModels()).resolves.toEqual([
      { id: 'a/model', name: 'Alpha' },
      { id: 'z/model', name: 'Zulu' },
    ])
    expect(rpc).toHaveBeenCalledWith('speech.models', {})
  })

  it('sends audio to the daemon over encrypted RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({ text: 'Ship it', model: 'custom/model' })
    useRelayStore.getState()._callRpc = rpc as typeof originalCallRpc

    await expect(
      transcribeWithDesktopOpenRouter({
        uri: 'file:///voice.m4a',
        model: 'custom/model',
      }),
    ).resolves.toEqual({ text: 'Ship it', model: 'custom/model' })
    expect(rpc).toHaveBeenCalledWith(
      'speech.transcribe',
      expect.objectContaining({ format: 'm4a', model: 'custom/model' }),
      { timeoutMs: 80_000 },
    )
  })

  it('reads credential presence without receiving the key', async () => {
    const rpc = vi.fn().mockResolvedValue({ configured: true, storage: 'os_credential_store' })
    useRelayStore.getState()._callRpc = rpc as typeof originalCallRpc
    await expect(getDesktopSpeechStatus()).resolves.toEqual({
      configured: true,
      storage: 'os_credential_store',
    })
  })
})
