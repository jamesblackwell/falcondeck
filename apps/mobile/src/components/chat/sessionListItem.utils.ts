export function formatRelativeTime(dateStr: string): string {
  const timestamp = new Date(dateStr).getTime()
  if (Number.isNaN(timestamp)) return 'now'

  const diff = Math.max(0, Date.now() - timestamp)
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`

  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`

  const days = Math.floor(hrs / 24)
  return `${days}d`
}
