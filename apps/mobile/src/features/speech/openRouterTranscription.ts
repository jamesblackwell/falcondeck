import { File } from 'expo-file-system'

import { useRelayStore } from '@/store/relay-store'

const TRANSCRIPTION_TIMEOUT_MS = 80_000
const MAX_AUDIO_BYTES = 8 * 1024 * 1024

export type SpeechModel = {
  id: string
  name: string
}

export async function fetchOpenRouterSpeechModels(): Promise<SpeechModel[]> {
  return useRelayStore.getState()._callRpc<SpeechModel[]>('speech.models', {})
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
  storage: 'os_credential_store'
}

export async function getDesktopSpeechStatus(): Promise<DesktopSpeechStatus> {
  return useRelayStore.getState()._callRpc<DesktopSpeechStatus>(
    'speech.status',
    {},
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
