import { vi } from 'vitest'

export const ExpoSpeechRecognitionModule = {
  isRecognitionAvailable: vi.fn(() => true),
  supportsOnDeviceRecognition: vi.fn(() => true),
  supportsRecording: vi.fn(() => true),
  requestMicrophonePermissionsAsync: vi.fn(async () => ({ granted: true })),
  start: vi.fn(),
  stop: vi.fn(),
  abort: vi.fn(),
}

export function useSpeechRecognitionEvent() {}
