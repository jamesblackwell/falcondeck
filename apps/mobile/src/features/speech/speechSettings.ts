import { getJson, removeKey, setJson } from '@/storage/mmkv'

const SPEECH_SETTINGS_KEY = 'fd.speechSettings.v2'
const LEGACY_SPEECH_SETTINGS_KEY = 'fd.speechSettings.v1'
const PENDING_RECORDING_KEY = 'fd.pendingVoiceRecording.v1'

export const DEFAULT_OPENROUTER_STT_MODEL = 'openai/gpt-4o-mini-transcribe'
// Models that were shipped as the default at some point. Found under the v1
// storage key they represent our old choice, not the user's, so the one-time
// v2 migration upgrades them; picked explicitly in v2 they stick.
const SUPERSEDED_DEFAULT_STT_MODELS = [
  'openai/whisper-large-v3-turbo',
  'openai/gpt-transcribe',
]

export type SpeechProvider = 'on-device' | 'openrouter'

export type SpeechSettings = {
  provider: SpeechProvider | null
  model: string
  language: string | null
}

export type PendingVoiceRecording = {
  uri: string
  createdAt: number
  provider: SpeechProvider
}

const DEFAULT_SETTINGS: SpeechSettings = {
  provider: null,
  model: DEFAULT_OPENROUTER_STT_MODEL,
  language: null,
}

function normalizeSpeechSettings(
  stored: Partial<SpeechSettings>,
): SpeechSettings {
  return {
    provider:
      stored.provider === 'on-device' || stored.provider === 'openrouter'
        ? stored.provider
        : null,
    model:
      typeof stored.model === 'string' && stored.model.trim()
        ? stored.model.trim()
        : DEFAULT_OPENROUTER_STT_MODEL,
    language:
      typeof stored.language === 'string' && stored.language.trim()
        ? stored.language.trim()
        : null,
  }
}

export function getSpeechSettings(): SpeechSettings {
  const stored = getJson<Partial<SpeechSettings>>(SPEECH_SETTINGS_KEY)
  if (stored) return normalizeSpeechSettings(stored)
  const legacy = getJson<Partial<SpeechSettings>>(LEGACY_SPEECH_SETTINGS_KEY)
  if (!legacy) return DEFAULT_SETTINGS
  const migrated = normalizeSpeechSettings(legacy)
  return SUPERSEDED_DEFAULT_STT_MODELS.includes(migrated.model)
    ? { ...migrated, model: DEFAULT_OPENROUTER_STT_MODEL }
    : migrated
}

export function updateSpeechSettings(
  patch: Partial<SpeechSettings>,
): SpeechSettings {
  const next = { ...getSpeechSettings(), ...patch }
  setJson(SPEECH_SETTINGS_KEY, next)
  return next
}

export function resetSpeechSettings(): void {
  removeKey(SPEECH_SETTINGS_KEY)
  removeKey(LEGACY_SPEECH_SETTINGS_KEY)
}

export function getPendingVoiceRecording(): PendingVoiceRecording | null {
  const pending = getJson<Partial<PendingVoiceRecording>>(PENDING_RECORDING_KEY)
  if (
    !pending ||
    typeof pending.uri !== 'string' ||
    typeof pending.createdAt !== 'number'
  ) {
    return null
  }
  const provider =
    pending.provider === 'on-device' || pending.provider === 'openrouter'
      ? pending.provider
      : (getSpeechSettings().provider ?? 'on-device')
  const normalized = {
    uri: pending.uri,
    createdAt: pending.createdAt,
    provider,
  }
  if (
    pending.provider !== 'on-device' &&
    pending.provider !== 'openrouter'
  ) {
    // Older builds did not record provenance. Pin the current explicit choice,
    // defaulting to the privacy-preserving local path, so it cannot later drift.
    setJson(PENDING_RECORDING_KEY, normalized)
  }
  return normalized
}

export function setPendingVoiceRecording(
  uri: string,
  provider: SpeechProvider,
): PendingVoiceRecording {
  const pending = { uri, createdAt: Date.now(), provider }
  setJson(PENDING_RECORDING_KEY, pending)
  return pending
}

export function clearPendingVoiceRecording(): void {
  removeKey(PENDING_RECORDING_KEY)
}
