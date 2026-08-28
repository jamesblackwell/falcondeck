import { vi } from 'vitest'

export class AudioBufferQueueSourceNode {
  enqueueBuffer = vi.fn(() => 'buffer')
  connect = vi.fn()
  start = vi.fn()
  stop = vi.fn()
}

export class AudioBufferSourceNode {
  buffer: unknown = null
  connect = vi.fn()
  start = vi.fn()
  stop = vi.fn()
  onEnded: (() => void) | null = null
}

export const mockSourceNodes: AudioBufferSourceNode[] = []
export const mockDecodeAudioData = vi.fn(async () => ({ duration: 1 }))

export const mockQueueNode = new AudioBufferQueueSourceNode()

export class AudioContext {
  destination = {}
  resume = vi.fn(async () => undefined)
  suspend = vi.fn(async () => undefined)
  createBufferQueueSource = vi.fn(() => mockQueueNode)
  createBufferSource = vi.fn(() => {
    const node = new AudioBufferSourceNode()
    mockSourceNodes.push(node)
    return node
  })
  decodeAudioData = mockDecodeAudioData
}

export class AudioBuffer {}

export const mockAudioManager = {
  setAudioSessionOptions: vi.fn(),
  setAudioSessionActivity: vi.fn(async () => undefined),
}

export const AudioManager = mockAudioManager

export const decodePCMInBase64 = vi.fn(async () => ({ duration: 0.02 }))
