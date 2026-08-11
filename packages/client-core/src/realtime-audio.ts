import { base64ToBytes } from './crypto'
import type { EncryptedEnvelope, EventEnvelope, RealtimeAudioChunk } from './types'

export type DecodedPcmAudio = {
  channels: Float32Array[]
  frameCount: number
  sampleRate: number
}

/** Decodes the provider's interleaved signed PCM16 payload into Web Audio channels. */
export function decodeRealtimePcm(chunk: RealtimeAudioChunk): DecodedPcmAudio | null {
  const channelCount = Math.trunc(chunk.num_channels)
  const sampleRate = Math.trunc(chunk.sample_rate)
  if (channelCount < 1 || channelCount > 8 || sampleRate < 8_000 || sampleRate > 192_000) {
    return null
  }

  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(chunk.data)
  } catch {
    return null
  }
  const bytesPerFrame = channelCount * 2
  if (bytes.length === 0 || bytes.length % bytesPerFrame !== 0) return null

  const frameCount = bytes.length / bytesPerFrame
  if (
    chunk.samples_per_channel !== null &&
    chunk.samples_per_channel > 0 &&
    chunk.samples_per_channel !== frameCount
  ) {
    return null
  }

  const channels = Array.from(
    { length: channelCount },
    () => new Float32Array(frameCount),
  )
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = view.getInt16((frame * channelCount + channel) * 2, true)
      channels[channel]![frame] = sample < 0 ? sample / 32_768 : sample / 32_767
    }
  }
  return { channels, frameCount, sampleRate }
}

export function isRealtimeAudioEvent(event: EventEnvelope): boolean {
  return event.event.type === 'realtime-audio-started' ||
    event.event.type === 'realtime-audio-delta' ||
    event.event.type === 'realtime-audio-ended'
}

export function isLiveRealtimeEvent(event: EventEnvelope): boolean {
  return isRealtimeAudioEvent(event) || event.event.type === 'realtime-item-added'
}

/** Returns an encrypted live daemon event without accepting arbitrary relay ephemerals. */
export function encryptedDaemonEventEnvelope(body: unknown): EncryptedEnvelope | null {
  if (!body || typeof body !== 'object') return null
  const candidate = body as { kind?: unknown; envelope?: unknown }
  if (candidate.kind !== 'encrypted-daemon-event' || !candidate.envelope || typeof candidate.envelope !== 'object') {
    return null
  }
  const envelope = candidate.envelope as { ciphertext?: unknown; encryption_variant?: unknown }
  if (typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length === 0) return null
  if (envelope.encryption_variant !== undefined && envelope.encryption_variant !== 'data_key_v1') {
    return null
  }
  return envelope as EncryptedEnvelope
}
