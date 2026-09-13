import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as AudioApi from 'react-native-audio-api'
import * as Speech from 'expo-speech'
import { DEMO_SESSION_ID, demoConversationItems } from '@/features/demo/demoData'

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
    useRelayStore.setState({ sessionId: null })
  })

  it('reads the long demo response offline with background audio and pause controls', async () => {
    useRelayStore.setState({ sessionId: DEMO_SESSION_ID })
    const rpc = vi.spyOn(useRelayStore.getState(), '_callRpc')
    const message = demoConversationItems.find((item) => item.id === 'msg-5')!
    expect(message.kind).toBe('assistant_message')
    if (message.kind !== 'assistant_message') throw new Error('Missing demo summary')
    expect(message.text.split(/\s+/).length).toBeGreaterThan(150)
    const player = new NativeReadAloudPlayer()
    player.toggle('demo-summary', message.text)
    await vi.waitFor(() => expect(Speech.speak).toHaveBeenCalled())
    expect(rpc).not.toHaveBeenCalled()
    const calls = vi.mocked(Speech.speak).mock.calls
    expect(calls.map(([text]) => text).join(' ')).toContain('Before deploying')
    const options = calls[0][1]!
    expect(options.useApplicationAudioSession).toBe(true)
    expect(AudioApi.AudioManager.setAudioSessionOptions).toHaveBeenCalledWith({
      iosCategory: 'playback', iosMode: 'spokenAudio',
    })
    options.onStart?.()
    expect(player.getSnapshot('demo-summary')).toBe('playing')
    await player.togglePause()
    expect(Speech.pause).toHaveBeenCalledOnce()
    expect(player.getSnapshot('demo-summary')).toBe('paused')
    await player.togglePause()
    expect(Speech.resume).toHaveBeenCalledOnce()
    calls.at(-1)![1]!.onDone?.()
    expect(player.getSnapshot('demo-summary')).toBe('idle')
  })

  it('cancels demo speech preparation and ignores callbacks from a replaced message', async () => {
    useRelayStore.setState({ sessionId: DEMO_SESSION_ID })
    const player = new NativeReadAloudPlayer()
    player.toggle('first', 'First message')
    player.stop()
    await Promise.resolve()
    expect(Speech.speak).not.toHaveBeenCalled()
    player.toggle('second', 'Second message')
    await vi.waitFor(() => expect(Speech.speak).toHaveBeenCalledOnce())
    const old = vi.mocked(Speech.speak).mock.calls[0][1]!
    player.toggle('third', 'A new message typed in the demo')
    await vi.waitFor(() => expect(Speech.speak).toHaveBeenCalledTimes(2))
    old.onStart?.()
    old.onError?.(new Error('late error'))
    old.onDone?.()
    expect(player.getSnapshot('third')).toBe('loading')
    const current = vi.mocked(Speech.speak).mock.calls[1][1]!
    current.onStart?.()
    expect(player.getSnapshot('third')).toBe('playing')
    player.stop()
    expect(Speech.stop).toHaveBeenCalled()
    expect(player.getSnapshot('third')).toBe('idle')
  })

  it('handles idempotent system pause/play commands in demo mode and clears completed playback', async () => {
    useRelayStore.setState({ sessionId: DEMO_SESSION_ID })
    const player = new NativeReadAloudPlayer()
    player.toggle('demo', 'Read this example aloud')
    await vi.waitFor(() => expect(Speech.speak).toHaveBeenCalledOnce())
    const speech = vi.mocked(Speech.speak).mock.calls[0][1]!
    speech.onStart?.()
    const calls = vi.mocked(AudioApi.PlaybackNotificationManager.addEventListener).mock.calls
    const pause = calls.find(([name]) => name === 'playbackNotificationPause')![1]
    const play = calls.find(([name]) => name === 'playbackNotificationPlay')![1]
    pause({})
    pause({})
    await vi.waitFor(() => expect(player.getSnapshot('demo')).toBe('paused'))
    expect(Speech.pause).toHaveBeenCalledOnce()
    play({})
    play({})
    await vi.waitFor(() => expect(player.getSnapshot('demo')).toBe('playing'))
    expect(Speech.resume).toHaveBeenCalledOnce()
    speech.onDone?.()
    await vi.waitFor(() => expect(AudioApi.PlaybackNotificationManager.hide).toHaveBeenCalled())
    expect(player.getSnapshot('demo')).toBe('idle')
    pause({})
    await Promise.resolve()
    expect(Speech.pause).toHaveBeenCalledOnce()
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
