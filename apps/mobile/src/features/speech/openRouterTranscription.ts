import { File } from 'expo-file-system'

import { useRelayStore } from '@/store/relay-store'

const TRANSCRIPTION_TIMEOUT_MS = 80_000
const SPEECH_STATUS_TIMEOUT_MS = 8_000
const SPEECH_MODELS_TIMEOUT_MS = 25_000
const MAX_AUDIO_BYTES = 8 * 1024 * 1024
export const TRANSCRIPTION_MAX_ATTEMPTS = 10
const TRANSCRIPTION_RETRY_BASE_MS = 500
const TRANSCRIPTION_RETRY_MAX_MS = 4_000

// Auth, quota, and payload problems will fail the same way on every attempt.
const PERMANENT_TRANSCRIPTION_ERROR =
  /too large to send securely|shorter clip|not configured|API key was rejected|needs credit|unsupported audio format|not valid base64|must be between 1 byte|invalid OpenRouter/i

export function isRetryableTranscriptionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return !PERMANENT_TRANSCRIPTION_ERROR.test(message)
}

export function transcriptionRetryDelayMs(failedAttempt: number): number {
  return Math.min(
    TRANSCRIPTION_RETRY_MAX_MS,
    TRANSCRIPTION_RETRY_BASE_MS * 2 ** Math.max(0, failedAttempt - 1),
  )
}

export function transcriptionProgressLabel(attempt: number): string {
  return attempt > 1 ? `Retrying (${attempt})` : 'Transcribing…'
}

export const transcriptionRetry = {
  wait: (ms: number) =>
    new Promise<void>((resolve) => {
      if (ms <= 0) {
        resolve()
        return
      }
      setTimeout(resolve, ms)
    }),
}

export type SpeechModel = {
  id: string
  name: string
}

export async function fetchOpenRouterSpeechModels(): Promise<SpeechModel[]> {
  return useRelayStore.getState()._callRpc<SpeechModel[]>(
    'speech.models',
    {},
    {
      timeoutMs: SPEECH_MODELS_TIMEOUT_MS,
    },
  )
}

function formatFromUri(uri: string): string {
  const extension = uri.split(/[?#]/, 1)[0]?.split('.').pop()?.toLowerCase()
  return extension &&
    ['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac'].includes(extension)
    ? extension
    : 'm4a'
}

export type DesktopSpeechStatus = {
  configured: boolean
  storage: 'daemon_secret_store'
}

export async function getDesktopSpeechStatus(): Promise<DesktopSpeechStatus> {
  return useRelayStore
    .getState()
    ._callRpc<DesktopSpeechStatus>(
      'speech.status',
      {},
      { timeoutMs: SPEECH_STATUS_TIMEOUT_MS },
    )
}

export async function transcribeWithDesktopOpenRouter({
  uri,
  model,
  language,
}: {
  uri: string
  model: string
  language?: string | null
}): Promise<{ text: string; model: string }> {
  const file = new File(uri)
  if (file.size > MAX_AUDIO_BYTES) {
    throw new Error(
      'This recording is too large to send securely. Please record a shorter clip.',
    )
  }
  const audio = await file.base64()
  return useRelayStore.getState()._callRpc<{ text: string; model: string }>(
    'speech.transcribe',
    {
      audio_base64: audio,
      format: formatFromUri(uri),
      model,
      ...(language ? { language } : {}),
    },
    { timeoutMs: TRANSCRIPTION_TIMEOUT_MS },
  )
}

export async function transcribeWithDesktopOpenRouterRetrying({
  uri,
  model,
  language,
  maxAttempts = TRANSCRIPTION_MAX_ATTEMPTS,
  onAttempt,
  isCancelled,
}: {
  uri: string
  model: string
  language?: string | null
  maxAttempts?: number
  onAttempt?: (attempt: number) => void
  isCancelled?: () => boolean
}): Promise<{ text: string; model: string }> {
  const attempts = Math.max(1, maxAttempts)
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (isCancelled?.()) {
      throw lastError instanceof Error
        ? lastError
        : new Error('Transcription cancelled.')
    }
    onAttempt?.(attempt)
    try {
      return await transcribeWithDesktopOpenRouter({ uri, model, language })
    } catch (cause) {
      lastError = cause
      const retry =
        attempt < attempts &&
        !isCancelled?.() &&
        isRetryableTranscriptionError(cause)
      if (!retry) throw cause
      await transcriptionRetry.wait(transcriptionRetryDelayMs(attempt))
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Transcription failed. Your recording is safe.')
}
