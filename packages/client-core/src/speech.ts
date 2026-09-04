import { base64ToBytes } from "./crypto";

/** Audio returned by the daemon after OpenRouter speech synthesis. */
export type SpeechSynthesisResponse = {
  audio_base64: string;
  mime_type: string;
};

export function speechSynthesisBlob({
  audio_base64,
  mime_type,
}: SpeechSynthesisResponse): Blob {
  return new Blob([base64ToBytes(audio_base64) as BlobPart], {
    type: mime_type || "audio/mpeg",
  });
}
