import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  fetchOpenRouterSpeechModels,
  getDesktopSpeechStatus,
  isRetryableTranscriptionError,
  transcriptionProgressLabel,
  transcriptionRetry,
  transcriptionRetryDelayMs,
  transcribeWithDesktopOpenRouter,
  transcribeWithDesktopOpenRouterRetrying,
} from './openRouterTranscription'
import { useRelayStore } from '@/store/relay-store'

describe('OpenRouter transcription', () => {
  const originalCallRpc = useRelayStore.getState()._callRpc
  const originalWait = transcriptionRetry.wait

  beforeEach(() => {
    transcriptionRetry.wait = vi.fn(async () => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    transcriptionRetry.wait = originalWait
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
    expect(rpc).toHaveBeenCalledWith('speech.models', {}, { timeoutMs: 25_000 })
  })

  it('sends audio to the daemon over encrypted RPC', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ text: 'Ship it', model: 'custom/model' })
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
    const rpc = vi
      .fn()
      .mockResolvedValue({ configured: true, storage: 'daemon_secret_store' })
    useRelayStore.getState()._callRpc = rpc as typeof originalCallRpc
    await expect(getDesktopSpeechStatus()).resolves.toEqual({
      configured: true,
      storage: 'daemon_secret_store',
    })
    expect(rpc).toHaveBeenCalledWith('speech.status', {}, { timeoutMs: 8_000 })
  })

  it('retries dropped connections and succeeds', async () => {
    const rpc = vi
      .fn()
      .mockRejectedValueOnce(new Error('Lost the relay connection'))
      .mockRejectedValueOnce(new Error('Timed out waiting for speech.transcribe'))
      .mockResolvedValue({ text: 'Ship it', model: 'custom/model' })
    useRelayStore.getState()._callRpc = rpc as typeof originalCallRpc
    const onAttempt = vi.fn()

    await expect(
      transcribeWithDesktopOpenRouterRetrying({
        uri: 'file:///voice.m4a',
        model: 'custom/model',
        onAttempt,
      }),
    ).resolves.toEqual({ text: 'Ship it', model: 'custom/model' })
    expect(rpc).toHaveBeenCalledTimes(3)
    expect(onAttempt).toHaveBeenCalledTimes(3)
    expect(onAttempt.mock.calls.map((call) => call[0])).toEqual([1, 2, 3])
    expect(transcriptionRetry.wait).toHaveBeenCalledTimes(2)
    expect(transcriptionRetry.wait).toHaveBeenNthCalledWith(1, 500)
    expect(transcriptionRetry.wait).toHaveBeenNthCalledWith(2, 1_000)
  })

  it('stops after ten retryable failures', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('Not connected to the relay'))
    useRelayStore.getState()._callRpc = rpc as typeof originalCallRpc

    await expect(
      transcribeWithDesktopOpenRouterRetrying({
        uri: 'file:///voice.m4a',
        model: 'custom/model',
      }),
    ).rejects.toThrow('Not connected to the relay')
    expect(rpc).toHaveBeenCalledTimes(10)
    expect(transcriptionRetry.wait).toHaveBeenCalledTimes(9)
  })

  it('does not retry a missing OpenRouter key', async () => {
    const rpc = vi
      .fn()
      .mockRejectedValue(
        new Error('OpenRouter is not configured on the connected desktop'),
      )
    useRelayStore.getState()._callRpc = rpc as typeof originalCallRpc

    await expect(
      transcribeWithDesktopOpenRouterRetrying({
        uri: 'file:///voice.m4a',
        model: 'custom/model',
      }),
    ).rejects.toThrow('not configured')
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(transcriptionRetry.wait).not.toHaveBeenCalled()
  })

  it('stops retrying when the recorder is cancelled', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('Lost the relay connection'))
    useRelayStore.getState()._callRpc = rpc as typeof originalCallRpc
    let cancelled = false

    await expect(
      transcribeWithDesktopOpenRouterRetrying({
        uri: 'file:///voice.m4a',
        model: 'custom/model',
        isCancelled: () => cancelled,
        onAttempt: (attempt) => {
          if (attempt >= 2) cancelled = true
        },
      }),
    ).rejects.toThrow('Lost the relay connection')
    expect(rpc).toHaveBeenCalledTimes(2)
  })
})

describe('transcription retry helpers', () => {
  it('backs off and caps the delay', () => {
    expect(transcriptionRetryDelayMs(1)).toBe(500)
    expect(transcriptionRetryDelayMs(2)).toBe(1_000)
    expect(transcriptionRetryDelayMs(3)).toBe(2_000)
    expect(transcriptionRetryDelayMs(4)).toBe(4_000)
    expect(transcriptionRetryDelayMs(10)).toBe(4_000)
  })

  it('keeps credential and payload errors from looping', () => {
    expect(
      isRetryableTranscriptionError(new Error('Lost the relay connection')),
    ).toBe(true)
    expect(
      isRetryableTranscriptionError(
        new Error('Timed out waiting for speech.transcribe'),
      ),
    ).toBe(true)
    expect(
      isRetryableTranscriptionError(
        new Error('The OpenRouter API key was rejected'),
      ),
    ).toBe(false)
    expect(
      isRetryableTranscriptionError(
        new Error(
          'This recording is too large to send securely. Please record a shorter clip.',
        ),
      ),
    ).toBe(false)
  })

  it('switches the in-progress label after the first attempt', () => {
    expect(transcriptionProgressLabel(1)).toBe('Transcribing…')
    expect(transcriptionProgressLabel(2)).toBe('Retrying (2)')
    expect(transcriptionProgressLabel(10)).toBe('Retrying (10)')
  })
})
