export type SpeechActivityMode =
  | 'listening'
  | 'transcribing'
  | 'playing'
  | 'paused'

export type SpeechActivityAction =
  | 'finish-recording'
  | 'cancel-recording'
  | 'toggle-playback'
  | 'stop-playback'

export type SpeechActivityActionListener = (action: SpeechActivityAction) => void

export interface SpeechLiveActivityController {
  initialize(): void
  startListening(startedAt?: number): void
  startPlaying(startedAt?: number): void
  setMode(mode: SpeechActivityMode): void
  end(): void
  subscribeAction(listener: SpeechActivityActionListener): () => void
}
