import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as AudioApi from 'react-native-audio-api'

import { NativeMediaAudioPlayer } from './media-audio-player'

const { mockSourceNodes, mockDecodeAudioData } = AudioApi as typeof AudioApi & {
  mockSourceNodes: Array<{
    buffer: unknown
    connect: ReturnType<typeof vi.fn>
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    onEnded: (() => void) | null
  }>
  mockDecodeAudioData: ReturnType<typeof vi.fn>
}

describe('NativeMediaAudioPlayer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSourceNodes.length = 0
  })

  it('decodes inline audio, publishes playback state, and resets when it ends', async () => {
    const player = new NativeMediaAudioPlayer()
    const listener = vi.fn()
    player.subscribe('result-1', listener)

    player.toggle('result-1', 'data:audio/wav;base64,aGVsbG8=')
    expect(player.getSnapshot('result-1')).toBe('loading')

    await vi.waitFor(() => expect(player.getSnapshot('result-1')).toBe('playing'))
    expect(mockDecodeAudioData.mock.calls[0][0]).toBeInstanceOf(ArrayBuffer)
    expect(mockSourceNodes).toHaveLength(1)
    expect(mockSourceNodes[0].connect).toHaveBeenCalledOnce()
    expect(mockSourceNodes[0].start).toHaveBeenCalledOnce()

    mockSourceNodes[0].onEnded?.()
    expect(player.getSnapshot('result-1')).toBe('idle')
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('stops the current output before playing another and cancels loading', async () => {
    const player = new NativeMediaAudioPlayer()
    player.toggle('first', 'https://example.com/first.wav')
    await vi.waitFor(() => expect(player.getSnapshot('first')).toBe('playing'))

    player.toggle('second', 'https://example.com/second.wav')
    expect(mockSourceNodes[0].stop).toHaveBeenCalledOnce()
    expect(player.getSnapshot('first')).toBe('idle')
    await vi.waitFor(() => expect(player.getSnapshot('second')).toBe('playing'))

    player.toggle('second', 'https://example.com/second.wav')
    expect(mockSourceNodes[1].stop).toHaveBeenCalledOnce()
    expect(player.getSnapshot('second')).toBe('idle')
  })

  it('surfaces decode failures as a retryable error state', async () => {
    mockDecodeAudioData.mockRejectedValueOnce(new Error('bad audio'))
    const player = new NativeMediaAudioPlayer()
    player.toggle('broken', 'https://example.com/broken.wav')

    await vi.waitFor(() => expect(player.getSnapshot('broken')).toBe('error'))
  })
})
