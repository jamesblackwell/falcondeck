import type {
  SpeechActivityActionListener,
  SpeechActivityMode,
  SpeechLiveActivityController,
} from './speechLiveActivity.types'

/** No-op implementation for Android, web and unit tests. */
class UnsupportedSpeechLiveActivity implements SpeechLiveActivityController {
  initialize(): void {}

  startListening(_startedAt = Date.now()): void {}

  startPlaying(_startedAt = Date.now()): void {}

  setMode(_mode: SpeechActivityMode): void {}

  end(): void {}

  subscribeAction(_listener: SpeechActivityActionListener): () => void {
    return () => {}
  }
}

export const speechLiveActivity = new UnsupportedSpeechLiveActivity()

export type {
  SpeechActivityAction,
  SpeechActivityActionListener,
  SpeechActivityMode,
} from './speechLiveActivity.types'
