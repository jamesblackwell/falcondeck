import { vi } from 'vitest'

export const AudioQuality = {
  MIN: 0,
  LOW: 0x20,
  MEDIUM: 0x40,
  HIGH: 0x60,
  MAX: 0x7f,
}

export const IOSOutputFormat = {
  MPEG4AAC: 'aac ',
}

export const RecordingPresets = { HIGH_QUALITY: {} }

const recorder = {
  id: 1,
  uri: 'file:///mock-cache/recording.m4a' as string | null,
  isRecording: false,
  prepareToRecordAsync: vi.fn(async () => {}),
  record: vi.fn(() => {
    recorder.isRecording = true
  }),
  stop: vi.fn(async () => {
    recorder.isRecording = false
  }),
}

export const requestRecordingPermissionsAsync = vi.fn(async () => ({
  granted: true,
}))
export const setAudioModeAsync = vi.fn(async () => {})
export const useAudioRecorder = vi.fn(() => recorder)

export function useAudioRecorderState() {
  return { isRecording: recorder.isRecording, durationMillis: 0 }
}
