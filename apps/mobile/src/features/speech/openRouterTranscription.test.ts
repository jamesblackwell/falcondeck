import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  fetchOpenRouterSpeechModels,
  transcribeWithOpenRouter,
} from './openRouterTranscription'

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response
}

describe('OpenRouter transcription', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('discovers and sorts transcription models', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse(200, {
          data: [
            { id: 'z/model', name: 'Zulu' },
            { id: 'a/model', name: 'Alpha' },
            { id: 3, name: 'Invalid' },
          ],
        }),
      ),
    )

    await expect(fetchOpenRouterSpeechModels()).resolves.toEqual([
      { id: 'a/model', name: 'Alpha' },
      { id: 'z/model', name: 'Zulu' },
    ])
  })

  it('falls back to another STT model after a transient provider failure', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse(503, { error: { message: 'unavailable' } }),
      )
      .mockResolvedValueOnce(mockResponse(200, { text: '  Ship it  ' }))
    vi.stubGlobal('fetch', fetch)

    await expect(
      transcribeWithOpenRouter({
        uri: 'file:///voice.m4a',
        apiKey: 'secret',
        model: 'custom/model',
      }),
    ).resolves.toEqual({ text: 'Ship it', model: 'openai/gpt-transcribe' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not retry a rejected API key', async () => {
    const fetch = vi.fn(async () => mockResponse(401, {}))
    vi.stubGlobal('fetch', fetch)

    await expect(
      transcribeWithOpenRouter({
        uri: 'file:///voice.wav',
        apiKey: 'bad-key',
        model: 'openai/gpt-transcribe',
      }),
    ).rejects.toThrow('API key was rejected')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
