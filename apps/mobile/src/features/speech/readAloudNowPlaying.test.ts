import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlaybackNotificationManager as notification } from 'react-native-audio-api'
import { ReadAloudNowPlaying } from './readAloudNowPlaying'

describe('ReadAloudNowPlaying', () => {
  beforeEach(() => vi.clearAllMocks())

  it('publishes branded playback and wires the actual remote commands', async () => {
    const controls = new ReadAloudNowPlaying()
    const pause = vi.fn()
    const stop = vi.fn()
    controls.start(pause, stop)
    await vi.waitFor(() => expect(notification.enableControl).toHaveBeenCalledWith('stop', true))
    expect(notification.show).toHaveBeenCalledWith({ title: 'Read Aloud', artist: 'FalconDeck', state: 'playing', speed: 1 })
    for (const control of ['nextTrack', 'previousTrack', 'skipForward', 'skipBackward', 'seekTo']) {
      expect(notification.enableControl).toHaveBeenCalledWith(control, false)
    }
    const calls = vi.mocked(notification.addEventListener).mock.calls
    calls.find(([name]) => name === 'playbackNotificationPause')![1]({})
    calls.find(([name]) => name === 'playbackNotificationPlay')![1]({})
    calls.find(([name]) => name === 'playbackNotificationStop')![1]({})
    expect(pause.mock.calls).toEqual([[true], [false]])
    expect(stop).toHaveBeenCalledOnce()
    controls.setPaused(true)
    await vi.waitFor(() => expect(notification.show).toHaveBeenLastCalledWith({ state: 'paused', speed: 0 }))
    controls.stop()
    await vi.waitFor(() => expect(notification.hide).toHaveBeenCalledOnce())
    expect(notification.enableControl).toHaveBeenCalledWith('play', false)
  })

  it('finishes an in-flight show before hiding, so stopped playback cannot reappear', async () => {
    let finish!: () => void
    vi.mocked(notification.show).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const controls = new ReadAloudNowPlaying()
    controls.start(vi.fn(), vi.fn())
    await vi.waitFor(() => expect(notification.show).toHaveBeenCalledOnce())
    controls.stop()
    expect(notification.hide).not.toHaveBeenCalled()
    finish()
    await vi.waitFor(() => expect(notification.hide).toHaveBeenCalledOnce())
    for (const result of vi.mocked(notification.addEventListener).mock.results) {
      expect(result.value.remove).toHaveBeenCalledOnce()
    }
  })
})
