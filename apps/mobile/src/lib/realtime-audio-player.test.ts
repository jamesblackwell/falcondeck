import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as AudioApi from 'react-native-audio-api'

import type { EventEnvelope, RealtimeAudioChunk } from '@falcondeck/client-core'

import { NativeRealtimeAudioPlayer } from './realtime-audio-player'

const { decodePCMInBase64 } = AudioApi
const { mockQueueNode } = AudioApi as typeof AudioApi & {
  mockQueueNode: {
    enqueueBuffer: ReturnType<typeof vi.fn>
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
  }
}

const chunk: RealtimeAudioChunk = {
  item_id: null,
  data: 'AAAA',
  sample_rate: 24_000,
  num_channels: 1,
  samples_per_channel: 1,
}

function envelope(
  event: EventEnvelope['event'],
): EventEnvelope {
  return {
    seq: 1,
    emitted_at: '2026-08-09T00:00:00Z',
    workspace_id: 'workspace-1',
    thread_id: 'thread-1',
    event,
  }
}

describe('NativeRealtimeAudioPlayer', () => {
  beforeEach(() => vi.clearAllMocks())

  it('decodes chunks in order and starts one native queue', async () => {
    const player = new NativeRealtimeAudioPlayer()
    player.handleEvent(envelope({ type: 'realtime-audio-started', session_id: 'voice-1' }))
    player.handleEvent(envelope({ type: 'realtime-audio-delta', audio: chunk }))
    player.handleEvent(envelope({ type: 'realtime-audio-delta', audio: chunk }))

    await vi.waitFor(() => expect(decodePCMInBase64).toHaveBeenCalledTimes(2))
    expect(mockQueueNode.enqueueBuffer).toHaveBeenCalledTimes(2)
    expect(mockQueueNode.start).toHaveBeenCalledTimes(1)
  })

  it('discards queued playback when realtime is interrupted', async () => {
    const player = new NativeRealtimeAudioPlayer()
    player.handleEvent(envelope({ type: 'realtime-audio-started', session_id: null }))
    player.handleEvent(envelope({ type: 'realtime-audio-delta', audio: chunk }))
    await vi.waitFor(() => expect(mockQueueNode.start).toHaveBeenCalledTimes(1))
    player.handleEvent(envelope({
      type: 'realtime-audio-ended',
      reason: 'connection lost',
      interrupted: true,
    }))

    expect(mockQueueNode.stop).toHaveBeenCalledTimes(1)
  })
})
