import { describe, expect, it } from 'vitest'

import { CLOUD_VOICE_RECORDING } from './cloudVoiceRecording'

describe('cloud voice recording', () => {
  it('captures 16 kHz mono speech instead of high-quality stereo', () => {
    expect(CLOUD_VOICE_RECORDING).toMatchObject({
      extension: '.m4a',
      sampleRate: 16_000,
      numberOfChannels: 1,
      bitRate: 32_000,
      android: {
        outputFormat: 'mpeg4',
        audioEncoder: 'aac',
      },
      ios: {
        outputFormat: 'aac ',
        audioQuality: 0x20,
      },
    })
  })
})
