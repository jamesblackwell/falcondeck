export function retentionSummary(hours: number): string {
  if (hours <= 0) {
    return "Recordings are deleted as soon as a transcript is pasted. Nothing is kept to retry.";
  }
  const window = hours === 1 ? "an hour" : `${hours} hours`;
  return `Recordings stay on this Mac for ${window} so you can retry a bad transcript with another model, then FalconDeck deletes them. They are never uploaded except to transcribe them.`;
}

export function formatRecordingLength(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

export function formatRecordedAt(recordedAtMs: number, now: number): string {
  // Rounding down keeps the label honest: a recording is only ever described
  // as older than it is once it has actually crossed that boundary.
  const minutes = Math.floor((now - recordedAtMs) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}
