import {
  AudioManager,
  AudioContext,
  type AudioBuffer,
  type AudioBufferSourceNode,
} from 'react-native-audio-api'

import {
  base64ToBytes,
  prepareReadAloudText,
  splitReadAloudText,
  type SpeechSynthesisResponse,
} from '@falcondeck/client-core'

import { mediaAudioPlayer } from '@/lib/media-audio-player'
import { useRelayStore } from '@/store/relay-store'

import { speechLiveActivity } from './speechLiveActivity'

export type ReadAloudState = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

type Listener = () => void
type Playback = {
  key: string
  node: AudioBufferSourceNode | null
  paused: boolean
  activityStarted: boolean
  unsubscribeActivityActions: (() => void) | null
}

const SPEECH_TIMEOUT_MS = 40_000

function audioBuffer(response: SpeechSynthesisResponse): ArrayBuffer {
  const bytes = base64ToBytes(response.audio_base64)
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function synthesize(text: string): Promise<SpeechSynthesisResponse> {
  return useRelayStore.getState()._callRpc<SpeechSynthesisResponse>(
    'speech.synthesize',
    { text },
    { timeoutMs: SPEECH_TIMEOUT_MS },
  )
}

/** One-at-a-time progressive Read Aloud playback for native clients. */
export class NativeReadAloudPlayer {
  private context: AudioContext | null = null
  private active: Playback | null = null
  private readonly states = new Map<string, ReadAloudState>()
  private readonly listeners = new Map<string, Set<Listener>>()

  getSnapshot = (key: string): ReadAloudState => this.states.get(key) ?? 'idle'

  subscribe = (key: string, listener: Listener): (() => void) => {
    const listeners = this.listeners.get(key) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(key)
    }
  }

  toggle(key: string, markdown: string): void {
    if (this.active?.key === key) {
      this.stop()
      return
    }

    const chunks = splitReadAloudText(prepareReadAloudText(markdown))
    if (chunks.length === 0) return
    this.stop()
    mediaAudioPlayer.stop()
    const playback: Playback = {
      key,
      node: null,
      paused: false,
      activityStarted: false,
      unsubscribeActivityActions: null,
    }
    this.active = playback
    this.activatePlaybackSession()
    void this.audioContext().resume().catch(() => undefined)
    this.setState(key, 'loading')
    void this.playChunks(playback, chunks)
  }

  stop(key?: string): void {
    const active = this.active
    if (!active || (key && active.key !== key)) return
    this.active = null
    this.finishLiveActivity(active)
    this.deactivatePlaybackSession()
    try {
      active.node?.stop()
    } catch {
      // The source may finish while a stop gesture is being handled.
    }
    this.setState(active.key, 'idle')
  }

  async togglePause(): Promise<void> {
    const playback = this.active
    if (!playback?.node || !playback.activityStarted) return
    try {
      if (playback.paused) {
        await this.audioContext().resume()
        if (this.active !== playback) return
        playback.paused = false
        speechLiveActivity.setMode('playing')
        this.setState(playback.key, 'playing')
      } else {
        await this.audioContext().suspend()
        if (this.active !== playback) return
        playback.paused = true
        speechLiveActivity.setMode('paused')
        this.setState(playback.key, 'paused')
      }
    } catch {
      // An interruption can race a Lock Screen pause or resume action.
    }
  }

  private async playChunks(playback: Playback, chunks: string[]): Promise<void> {
    const prefetch = (text: string) => {
      const pending = synthesize(text).then((response) =>
        this.audioContext().decodeAudioData(audioBuffer(response)),
      )
      void pending.catch(() => undefined)
      return pending
    }

    try {
      let next: Promise<AudioBuffer> | null = prefetch(chunks[0]!)
      for (let index = 0; index < chunks.length; index += 1) {
        const pending = next
        if (!pending) return
        const decoded = await pending
        if (this.active !== playback) return
        next = index + 1 < chunks.length ? prefetch(chunks[index + 1]!) : null
        await this.playBuffer(playback, decoded)
        if (this.active !== playback) return
      }
      this.active = null
      this.finishLiveActivity(playback)
      this.deactivatePlaybackSession()
      this.setState(playback.key, 'idle')
    } catch {
      if (this.active !== playback) return
      this.active = null
      this.finishLiveActivity(playback)
      this.deactivatePlaybackSession()
      try {
        playback.node?.stop()
      } catch {
        // Decode or playback can fail before a source is stoppable.
      }
      this.setState(playback.key, 'error')
    }
  }

  private playBuffer(playback: Playback, buffer: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      const context = this.audioContext()
      const node = context.createBufferSource()
      playback.node = node
      node.buffer = buffer
      node.connect(context.destination)
      node.onEnded = () => {
        if (playback.node === node) playback.node = null
        resolve()
      }
      if (!playback.activityStarted) {
        playback.activityStarted = true
        speechLiveActivity.startPlaying()
        playback.unsubscribeActivityActions = speechLiveActivity.subscribeAction((action) => {
          if (this.active !== playback) return
          if (action === 'toggle-playback') void this.togglePause()
          if (action === 'stop-playback') this.stop(playback.key)
        })
      }
      this.setState(playback.key, 'playing')
      node.start()
    })
  }

  private setState(key: string, state: ReadAloudState): void {
    if (state === 'idle') this.states.delete(key)
    else this.states.set(key, state)
    this.listeners.get(key)?.forEach((listener) => listener())
  }

  private audioContext(): AudioContext {
    this.context ??= new AudioContext()
    return this.context
  }

  private finishLiveActivity(playback: Playback): void {
    playback.unsubscribeActivityActions?.()
    playback.unsubscribeActivityActions = null
    if (!playback.activityStarted) return
    playback.activityStarted = false
    speechLiveActivity.end()
  }

  /**
   * Marks the audio session as spoken-audio playback so iOS keeps it running
   * when the device is locked or the app is backgrounded (requires the
   * UIBackgroundModes audio entitlement). Without this the session defaults to
   * ambient and playback is suspended on lock.
   */
  private activatePlaybackSession(): void {
    try {
      AudioManager.setAudioSessionOptions({
        iosCategory: 'playback',
        iosMode: 'spokenAudio',
      })
      void AudioManager.setAudioSessionActivity(true).catch(() => undefined)
    } catch {
      // Session configuration is best-effort; playback still works in-app.
    }
  }

  private deactivatePlaybackSession(): void {
    void AudioManager.setAudioSessionActivity(false).catch(() => undefined)
  }
}

export const readAloudPlayer = new NativeReadAloudPlayer()
