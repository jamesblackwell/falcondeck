/** Compact received-at label for a message footer ("1h ago", "2d ago"). */
export function formatReceivedAgo(
  dateStr: string,
  nowMs: number = Date.now(),
): string | null {
  const timestamp = Date.parse(dateStr);
  if (!Number.isFinite(timestamp)) return null;

  const diff = Math.max(0, nowMs - timestamp);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;

  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;

  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
