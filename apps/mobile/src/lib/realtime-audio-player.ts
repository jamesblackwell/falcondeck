import {
  AudioContext,
  decodePCMInBase64,
  type AudioBufferQueueSourceNode,
} from 'react-native-audio-api'

import type { EventEnvelope } from '@falcondeck/client-core'

type PlaybackState = {
  chain: Promise<void>
  drained: boolean
  ending: boolean
  node: AudioBufferQueueSourceNode | null
  started: boolean
}

/** Native low-latency PCM queue for realtime assistant speech. */
export class NativeRealtimeAudioPlayer {
  private context: AudioContext | null = null
  private readonly threads = new Map<string, PlaybackState>()

  handleEvent(envelope: EventEnvelope): void {
    const threadId = envelope.thread_id
    if (!threadId) return
    const event = envelope.event
    if (event.type === 'realtime-audio-started') {
      this.stop(threadId)
      this.threads.set(threadId, this.createState())
      return
    }
    if (event.type === 'realtime-audio-ended') {
      if (event.interrupted) {
        this.stop(threadId)
      } else {
        const state = this.threads.get(threadId)
        if (state) {
          state.ending = true
          state.chain = state.chain.finally(() => {
            // Enqueueing is complete before CoreAudio drains the queue. Keep
            // ownership until its final-buffer event so a replacement session
            // can still stop the native queue.
            if (
              this.threads.get(threadId) === state
              && (!state.node || state.drained)
            ) {
              this.finishPlayback(threadId, state)
            }
          })
        }
      }
      return
    }
    if (event.type !== 'realtime-audio-delta') return

    const state = this.threads.get(threadId) ?? this.createState()
    this.threads.set(threadId, state)
    const chunk = event.audio
    state.chain = state.chain
      .then(async () => {
        if (this.threads.get(threadId) !== state) return
        const context = this.audioContext()
        const buffer = await decodePCMInBase64(
          chunk.data,
          chunk.sample_rate,
          chunk.num_channels,
          true,
        )
        if (this.threads.get(threadId) !== state) return
        const node = state.node ?? context.createBufferQueueSource()
        if (!state.node) {
          state.node = node
          node.connect(context.destination)
          node.onBufferEnded = ({ isLastBufferInQueue }) => {
            if (state.node !== node || !isLastBufferInQueue) return
            state.drained = true
            if (state.ending && this.threads.get(threadId) === state) {
              state.chain = state.chain.finally(() => {
                if (
                  this.threads.get(threadId) === state
                  && state.node === node
                  && state.drained
                ) {
                  this.finishPlayback(threadId, state)
                }
              })
            }
          }
        }
        state.drained = false
        node.enqueueBuffer(buffer)
        if (!state.started) {
          state.started = true
          node.start()
        }
      })
      .catch(() => undefined)
  }

  stop(threadId?: string): void {
    const targets = threadId
      ? [[threadId, this.threads.get(threadId)] as const]
      : [...this.threads.entries()]
    for (const [id, state] of targets) {
      if (!state) continue
      this.finishPlayback(id, state)
    }
    this.suspendWhenIdle()
  }

  private createState(): PlaybackState {
    return {
      chain: Promise.resolve(),
      drained: false,
      ending: false,
      node: null,
      started: false,
    }
  }

  private finishPlayback(threadId: string, state: PlaybackState): void {
    if (this.threads.get(threadId) !== state) return
    const node = state.node
    state.node = null
    if (node) {
      node.onBufferEnded = null
      try {
        node.stop()
      } catch {
        // The native source may already have been stopped explicitly.
      }
    }
    this.threads.delete(threadId)
    this.suspendWhenIdle()
  }

  private audioContext(): AudioContext {
    this.context ??= new AudioContext()
    void this.context.resume().catch(() => undefined)
    return this.context
  }

  private suspendWhenIdle(): void {
    if (this.threads.size === 0 && this.context) {
      // Suspend the CoreAudio render graph while idle; a resumed context
      // otherwise keeps the audio unit spinning for the rest of the session.
      void this.context.suspend().catch(() => undefined)
    }
  }
}

export const realtimeAudioPlayer = new NativeRealtimeAudioPlayer()
