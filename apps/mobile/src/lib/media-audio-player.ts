import {
  AudioContext,
  type AudioBuffer,
  type AudioBufferSourceNode,
} from 'react-native-audio-api'

import { base64ToBytes } from '@falcondeck/client-core'

export type MediaAudioState = 'idle' | 'loading' | 'playing' | 'error'

type Listener = () => void

type ActivePlayback = {
  key: string
  node: AudioBufferSourceNode | null
  generation: number
}

const MAX_CACHED_OUTPUTS = 8
const DATA_AUDIO_URL = /^data:audio\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i

function dataAudioBuffer(url: string): ArrayBuffer | null {
  const match = DATA_AUDIO_URL.exec(url)
  if (!match) return null
  const bytes = base64ToBytes(match[1].replace(/\s/g, ''))
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

/**
 * One-at-a-time player for finite audio returned by tools.
 *
 * A singleton prevents several expanded cards from speaking over each other.
 * Decode promises are cached with a small LRU-style bound because provider
 * results can contain large inline data URLs and conversations are long-lived.
 */
export class NativeMediaAudioPlayer {
  private context: AudioContext | null = null
  private active: ActivePlayback | null = null
  private generation = 0
  private readonly states = new Map<string, MediaAudioState>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly buffers = new Map<string, Promise<AudioBuffer>>()

  getSnapshot = (key: string): MediaAudioState => this.states.get(key) ?? 'idle'

  subscribe = (key: string, listener: Listener): (() => void) => {
    const listeners = this.listeners.get(key) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.listeners.delete(key)
        if (this.active?.key !== key) this.states.delete(key)
      }
    }
  }

  toggle(key: string, url: string): void {
    if (this.active?.key === key) {
      this.stop()
      return
    }

    this.stop()
    const generation = ++this.generation
    const playback: ActivePlayback = { key, node: null, generation }
    this.active = playback
    this.setState(key, 'loading')

    // Decomposing an inline data URL can throw before decodeAudioData returns
    // its promise. Start on a promise boundary so every malformed tool result
    // reaches the same retryable error state instead of escaping the tap.
    void Promise.resolve()
      .then(() => this.decode(url))
      .then((buffer) => {
        if (this.active !== playback || playback.generation !== generation) return
        const context = this.audioContext()
        const node = context.createBufferSource()
        playback.node = node
        node.buffer = buffer
        node.connect(context.destination)
        node.onEnded = () => {
          if (this.active === playback) {
            this.active = null
            this.setState(key, 'idle')
            if (this.context) {
              void this.context.suspend().catch(() => undefined)
            }
          }
        }
        this.setState(key, 'playing')
        node.start()
      })
      .catch(() => {
        this.buffers.delete(url)
        if (this.active === playback) {
          this.active = null
          try {
            playback.node?.stop()
          } catch {
            // The source may have failed before it entered a stoppable state.
          }
          this.setState(key, 'error')
        }
      })
  }

  stop(key?: string): void {
    const active = this.active
    if (!active || (key && active.key !== key)) return
    this.active = null
    this.generation += 1
    try {
      active.node?.stop()
    } catch {
      // A finite native source can race its own ended callback.
    }
    this.setState(active.key, 'idle')
    if (this.context) {
      // Suspend the CoreAudio render graph while idle; a resumed context
      // otherwise keeps the audio unit spinning for the rest of the session.
      void this.context.suspend().catch(() => undefined)
    }
  }

  private setState(key: string, state: MediaAudioState): void {
    if (state === 'idle') this.states.delete(key)
    else this.states.set(key, state)
    this.listeners.get(key)?.forEach((listener) => listener())
  }

  private decode(url: string): Promise<AudioBuffer> {
    const cached = this.buffers.get(url)
    if (cached) {
      this.buffers.delete(url)
      this.buffers.set(url, cached)
      return cached
    }

    const context = this.audioContext()
    const inlineBuffer = dataAudioBuffer(url)
    const promise = context.decodeAudioData(inlineBuffer ?? url)
    this.buffers.set(url, promise)
    while (this.buffers.size > MAX_CACHED_OUTPUTS) {
      const oldest = this.buffers.keys().next().value
      if (typeof oldest !== 'string') break
      this.buffers.delete(oldest)
    }
    return promise
  }

  private audioContext(): AudioContext {
    this.context ??= new AudioContext()
    void this.context.resume().catch(() => undefined)
    return this.context
  }
}

export const mediaAudioPlayer = new NativeMediaAudioPlayer()
