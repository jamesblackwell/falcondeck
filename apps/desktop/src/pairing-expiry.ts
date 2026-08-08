import { useEffect, useState } from 'react'

/**
 * Milliseconds left on a pairing code, re-read once a second so the UI never
 * presents a dead code as if it were live. Returns null when there is no expiry
 * to track, and stops ticking once the code is gone.
 */
export function useMillisUntil(expiresAt: string | null | undefined) {
  const expiryMs = expiresAt ? Date.parse(expiresAt) : Number.NaN
  const [remainingMs, setRemainingMs] = useState<number | null>(() =>
    Number.isNaN(expiryMs) ? null : expiryMs - Date.now(),
  )

  useEffect(() => {
    if (Number.isNaN(expiryMs)) {
      setRemainingMs(null)
      return
    }

    const tick = () => {
      const next = expiryMs - Date.now()
      setRemainingMs(next)
      return next
    }

    if (tick() <= 0) {
      return
    }
    const timer = window.setInterval(() => {
      if (tick() <= 0) {
        window.clearInterval(timer)
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [expiryMs])

  return remainingMs
}

export function formatCountdown(remainingMs: number) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}
