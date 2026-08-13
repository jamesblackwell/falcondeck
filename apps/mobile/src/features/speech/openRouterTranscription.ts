import { File } from 'expo-file-system'

import { fetchWithTimeout } from '@/lib/fetch-timeout'

import { DEFAULT_OPENROUTER_STT_MODEL } from './speechSettings'

const OPENROUTER_API = 'https://openrouter.ai/api/v1'
const TRANSCRIPTION_TIMEOUT_MS = 65_000

export type SpeechModel = {
  id: string
  name: string
}

type ModelsResponse = {
  data?: Array<{ id?: unknown; name?: unknown }>
}

type TranscriptionResponse = {
  text?: unknown
  error?: { message?: unknown }
}

const FALLBACK_MODELS = [
  DEFAULT_OPENROUTER_STT_MODEL,
  'openai/gpt-4o-transcribe',
  'deepgram/nova-3',
  'openai/whisper-large-v3',
]

export async function fetchOpenRouterSpeechModels(): Promise<SpeechModel[]> {
  const response = await fetchWithTimeout(
    `${OPENROUTER_API}/models?output_modalities=transcription`,
  )
  if (!response.ok) throw new Error('Could not load transcription models')
  const body = (await response.json()) as ModelsResponse
  return (body.data ?? [])
    .flatMap((model) =>
      typeof model.id === 'string'
        ? [
            {
              id: model.id,
              name: typeof model.name === 'string' ? model.name : model.id,
            },
          ]
        : [],
    )
    .sort((left, right) => left.name.localeCompare(right.name))
}

function formatFromUri(uri: string): string {
  const extension = uri.split(/[?#]/, 1)[0]?.split('.').pop()?.toLowerCase()
  return extension &&
    ['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac'].includes(extension)
    ? extension
    : 'm4a'
}

function responseError(status: number, body: TranscriptionResponse): Error {
  const detail =
    typeof body.error?.message === 'string' ? body.error.message : null
  if (status === 401) return new Error('The OpenRouter API key was rejected.')
  if (status === 402)
    return new Error(
      'This OpenRouter account needs credit before it can transcribe audio.',
    )
  if (status === 429)
    return new Error(
      'OpenRouter is rate limited. Your recording is safe; try again shortly.',
    )
  return new Error(detail ?? `Transcription failed (${status}).`)
}

function shouldTryFallback(status: number): boolean {
  return (
    status === 404 ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500
  )
}

export async function transcribeWithOpenRouter({
  uri,
  apiKey,
  model,
  language,
}: {
  uri: string
  apiKey: string
  model: string
  language?: string | null
}): Promise<{ text: string; model: string }> {
  const audio = await new File(uri).base64()
  const models = [...new Set([model, ...FALLBACK_MODELS])].slice(0, 4)
  let lastError = new Error('Transcription failed.')

  for (const candidate of models) {
    let response: Response
    try {
      response = await fetchWithTimeout(
        `${OPENROUTER_API}/audio/transcriptions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'X-Title': 'FalconDeck Mobile',
          },
          body: JSON.stringify({
            model: candidate,
            input_audio: { data: audio, format: formatFromUri(uri) },
            ...(language ? { language } : {}),
            temperature: 0,
          }),
        },
        TRANSCRIPTION_TIMEOUT_MS,
      )
    } catch (error) {
      lastError = error instanceof Error ? error : lastError
      continue
    }

    let body: TranscriptionResponse = {}
    try {
      body = (await response.json()) as TranscriptionResponse
    } catch {
      // The status-specific message below is more useful than a JSON parse error.
    }
    if (response.ok && typeof body.text === 'string' && body.text.trim()) {
      return { text: body.text.trim(), model: candidate }
    }

    lastError = responseError(response.status, body)
    if (!shouldTryFallback(response.status)) throw lastError
  }

  throw lastError
}
