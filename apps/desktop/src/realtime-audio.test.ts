import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  applyConversationEventToItems,
  decodeRealtimePcm,
  encryptedDaemonEventEnvelope,
  type EventEnvelope,
} from '@falcondeck/client-core'
import { RealtimeAudioPlayer } from '@falcondeck/chat-ui'

const chunk = {
  item_id: 'voice-1',
  data: 'AIAAAP9/AMA=',
  sample_rate: 24_000,
  num_channels: 2,
  samples_per_channel: 2,
}

function audioEvent(type: EventEnvelope['event']['type']): EventEnvelope {
  const event = type === 'realtime-audio-delta'
    ? { type, audio: chunk } as const
    : type === 'realtime-audio-ended'
      ? { type, reason: null, interrupted: false } as const
      : { type: 'realtime-audio-started' as const, session_id: 'session-1' }
  return {
    seq: 1,
    emitted_at: '2026-08-09T00:00:00Z',
    workspace_id: 'workspace-1',
    thread_id: 'thread-1',
    event,
  }
}

describe('realtime audio', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('decodes interleaved signed PCM16 into normalized channels', () => {
    const decoded = decodeRealtimePcm(chunk)
    expect(decoded?.frameCount).toBe(2)
    expect(Array.from(decoded?.channels[0] ?? [])).toEqual([-1, 1])
    expect(Array.from(decoded?.channels[1] ?? [])).toEqual([0, -0.5])
  })

  it('rejects malformed frame counts and unrelated relay ephemerals', () => {
    expect(decodeRealtimePcm({ ...chunk, samples_per_channel: 3 })).toBeNull()
    expect(encryptedDaemonEventEnvelope({ kind: 'request-bootstrap' })).toBeNull()
    expect(encryptedDaemonEventEnvelope({
      kind: 'encrypted-daemon-event',
      envelope: { encryption_variant: 'data_key_v1', ciphertext: 'ciphertext' },
    })).toEqual({ encryption_variant: 'data_key_v1', ciphertext: 'ciphertext' })
  })

  it('schedules consecutive chunks without gaps and drains a normal close', () => {
    const starts: number[] = []
    const sources: Array<{ stop: ReturnType<typeof vi.fn> }> = []
    class FakeAudioContext {
      currentTime = 10
      destination = {}
      resume = vi.fn(async () => undefined)
      createBuffer = vi.fn(() => ({
        duration: 2 / 24_000,
        copyToChannel: vi.fn(),
      }))
      createBufferSource = vi.fn(() => {
        const source = {
          buffer: null,
          connect: vi.fn(),
          start: vi.fn((when: number) => starts.push(when)),
          stop: vi.fn(),
          onended: null,
        }
        sources.push(source)
        return source
      })
    }
    vi.stubGlobal('AudioContext', FakeAudioContext)

    const player = new RealtimeAudioPlayer()
    player.handleEvent(audioEvent('realtime-audio-started'))
    player.handleEvent(audioEvent('realtime-audio-delta'))
    player.handleEvent(audioEvent('realtime-audio-delta'))
    player.handleEvent(audioEvent('realtime-audio-ended'))

    expect(starts).toEqual([10.025, 10.025 + 2 / 24_000])
    expect(sources.every((source) => source.stop.mock.calls.length === 0)).toBe(true)
  })

  it('projects raw realtime items into inspectable conversation cards', () => {
    const event: EventEnvelope = {
      seq: 4,
      emitted_at: '2026-08-09T00:00:00Z',
      workspace_id: 'workspace-1',
      thread_id: 'thread-1',
      event: {
        type: 'realtime-item-added',
        item: {
          id: 'handoff-1',
          item_type: 'handoff_request',
          title: 'Voice handoff requested',
          summary: 'Continue in Codex',
          payload: { type: 'handoff_request' },
          created_at: '2026-08-09T00:00:00Z',
        },
      },
    }

    expect(applyConversationEventToItems([], event)).toEqual([
      { kind: 'realtime', ...event.event.item },
    ])
  })
})
