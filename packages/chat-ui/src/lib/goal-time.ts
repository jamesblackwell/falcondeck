import { useEffect, useState } from 'react'

/**
 * Elapsed wall-clock time since a goal started, as a compact label
 * ("42s", "12m 05s", "1h 07m"). Null when the daemon didn't stamp a start
 * (older daemons) or the stamp doesn't parse.
 */
export function formatGoalElapsed(
  startedAt: string | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (!startedAt) return null
  const startMs = Date.parse(startedAt)
  if (!Number.isFinite(startMs)) return null
  const totalSeconds = Math.max(0, Math.floor((nowMs - startMs) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

/** The elapsed label, re-rendered every second while the goal runs. */
export function useGoalElapsedLabel(startedAt: string | null | undefined): string | null {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!startedAt) return
    setNowMs(Date.now())
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [startedAt])
  return formatGoalElapsed(startedAt, nowMs)
}
