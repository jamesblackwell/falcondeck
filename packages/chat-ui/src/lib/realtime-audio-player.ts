import { decodeRealtimePcm, type EventEnvelope } from '@falcondeck/client-core'

type BrowserAudioContext = AudioContext

type PlaybackState = {
  nextStartTime: number
  sources: Set<AudioBufferSourceNode>
}

/** Low-latency, gap-resistant PCM playback shared by desktop and remote web. */
export class RealtimeAudioPlayer {
  private context: BrowserAudioContext | null = null
  private readonly threads = new Map<string, PlaybackState>()

  handleEvent(envelope: EventEnvelope): void {
    const threadId = envelope.thread_id
    if (!threadId) return
    const event = envelope.event
    if (event.type === 'realtime-audio-started') {
      this.stop(threadId)
      this.threads.set(threadId, { nextStartTime: 0, sources: new Set() })
      return
    }
    if (event.type === 'realtime-audio-ended') {
      if (event.interrupted) this.stop(threadId)
      else this.threads.delete(threadId)
      return
    }
    if (event.type !== 'realtime-audio-delta') return
    const decoded = decodeRealtimePcm(event.audio)
    if (!decoded) return

    const context = this.audioContext()
    if (!context) return
    void context.resume().catch(() => undefined)
    const state = this.threads.get(threadId) ?? { nextStartTime: 0, sources: new Set() }
    this.threads.set(threadId, state)

    const buffer = context.createBuffer(
      decoded.channels.length,
      decoded.frameCount,
      decoded.sampleRate,
    )
    for (let channel = 0; channel < decoded.channels.length; channel += 1) {
      buffer.copyToChannel(new Float32Array(decoded.channels[channel]!), channel)
    }
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.onended = () => state.sources.delete(source)
    state.sources.add(source)

    const safetyLead = 0.025
    const earliest = context.currentTime + safetyLead
    // A suspended tab or missing chunk can leave the old schedule far behind.
    const startAt = state.nextStartTime < earliest || state.nextStartTime > earliest + 1
      ? earliest
      : state.nextStartTime
    source.start(startAt)
    state.nextStartTime = startAt + buffer.duration
  }

  stop(threadId?: string): void {
    const targets = threadId
      ? [[threadId, this.threads.get(threadId)] as const]
      : [...this.threads.entries()]
    for (const [id, state] of targets) {
      if (!state) continue
      for (const source of state.sources) {
        try {
          source.stop()
        } catch {
          // A source that naturally ended is already stopped.
        }
      }
      this.threads.delete(id)
    }
  }

  private audioContext(): BrowserAudioContext | null {
    if (this.context) return this.context
    if (typeof window === 'undefined') return null
    const Constructor = window.AudioContext
    if (!Constructor) return null
    this.context = new Constructor({ latencyHint: 'interactive' })
    return this.context
  }
}

export const realtimeAudioPlayer = new RealtimeAudioPlayer()
