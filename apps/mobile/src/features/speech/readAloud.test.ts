import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as AudioApi from 'react-native-audio-api'

import { useRelayStore } from '@/store/relay-store'

import { NativeReadAloudPlayer } from './readAloud'
import {
  speechLiveActivity,
  type SpeechActivityActionListener,
} from './speechLiveActivity'

const { mockSourceNodes } = AudioApi as typeof AudioApi & {
  mockSourceNodes: Array<{
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    onEnded: (() => void) | null
  }>
}

describe('NativeReadAloudPlayer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSourceNodes.length = 0
  })

  it('prefetches chunks and plays them in sequence', async () => {
    const startPlaying = vi.spyOn(speechLiveActivity, 'startPlaying')
    const setActivityMode = vi.spyOn(speechLiveActivity, 'setMode')
    const endActivity = vi.spyOn(speechLiveActivity, 'end')
    const callRpc = vi
      .spyOn(useRelayStore.getState(), '_callRpc')
      .mockResolvedValue({ audio_base64: 'aGVsbG8=', mime_type: 'audio/mpeg' })
    const player = new NativeReadAloudPlayer()

    player.toggle('message-1', `Start ${'word '.repeat(180)}`)
    expect(player.getSnapshot('message-1')).toBe('loading')
    await vi.waitFor(() => expect(player.getSnapshot('message-1')).toBe('playing'))
    expect(startPlaying).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(callRpc).toHaveBeenCalledTimes(2))

    await player.togglePause()
    expect(player.getSnapshot('message-1')).toBe('paused')
    expect(setActivityMode).toHaveBeenLastCalledWith('paused')
    await player.togglePause()
    expect(player.getSnapshot('message-1')).toBe('playing')
    expect(setActivityMode).toHaveBeenLastCalledWith('playing')

    mockSourceNodes[0].onEnded?.()
    await vi.waitFor(() => expect(mockSourceNodes).toHaveLength(2))
    mockSourceNodes[1].onEnded?.()
    await vi.waitFor(() => expect(player.getSnapshot('message-1')).toBe('idle'))
    expect(endActivity).toHaveBeenCalledTimes(1)
  })

  it('cancels preparation and ignores its late result', async () => {
    let finish: ((value: { audio_base64: string; mime_type: string }) => void) | undefined
    vi.spyOn(useRelayStore.getState(), '_callRpc').mockReturnValue(
      new Promise((resolve) => { finish = resolve }),
    )
    const player = new NativeReadAloudPlayer()

    player.toggle('message-1', 'Speak this response')
    player.toggle('message-1', 'Speak this response')
    finish?.({ audio_base64: 'aGVsbG8=', mime_type: 'audio/mpeg' })

    await vi.waitFor(() => expect(player.getSnapshot('message-1')).toBe('idle'))
    expect(mockSourceNodes).toHaveLength(0)
  })

  it('handles pause, resume, and stop from the Lock Screen controls', async () => {
    let activityAction: SpeechActivityActionListener = () => {}
    const unsubscribe = vi.fn()
    vi.spyOn(speechLiveActivity, 'subscribeAction').mockImplementation(
      (listener) => {
        activityAction = listener
        return unsubscribe
      },
    )
    vi.spyOn(useRelayStore.getState(), '_callRpc').mockResolvedValue({
      audio_base64: 'aGVsbG8=',
      mime_type: 'audio/mpeg',
    })
    const player = new NativeReadAloudPlayer()

    player.toggle('message-1', 'Speak this response')
    await vi.waitFor(() => expect(player.getSnapshot('message-1')).toBe('playing'))

    activityAction('toggle-playback')
    await vi.waitFor(() => expect(player.getSnapshot('message-1')).toBe('paused'))
    activityAction('toggle-playback')
    await vi.waitFor(() => expect(player.getSnapshot('message-1')).toBe('playing'))
    activityAction('stop-playback')

    expect(player.getSnapshot('message-1')).toBe('idle')
    expect(mockSourceNodes[0].stop).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
})
