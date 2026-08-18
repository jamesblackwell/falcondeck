/** Where a transcript landed, so the caller can park the caret after it. */
export type TranscriptInsertion = { value: string; caret: number };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Splice a voice transcript into a draft at the caret, keeping exactly one
 * space either side of the seam. Dictation is additive: recording into a
 * half-written prompt must extend it rather than replace it, and a selection
 * is treated the same as typing — the transcript takes its place.
 *
 * Callers with no caret to offer (a composer that has never been touched in
 * this conversation) get an append.
 */
export function insertTranscript(
  value: string,
  transcript: string,
  selection?: { start: number; end: number } | null,
): TranscriptInsertion {
  const text = transcript.trim();
  const requestedStart = selection?.start ?? value.length;
  if (!text) return { value, caret: clamp(requestedStart, 0, value.length) };

  const start = clamp(requestedStart, 0, value.length);
  const end = clamp(selection?.end ?? start, start, value.length);
  const before = value.slice(0, start);
  const after = value.slice(end);
  const prefix = before && !/\s$/.test(before) ? " " : "";
  const suffix = after && !/^\s/.test(after) ? " " : "";

  return {
    value: `${before}${prefix}${text}${suffix}${after}`,
    caret: before.length + prefix.length + text.length,
  };
}
