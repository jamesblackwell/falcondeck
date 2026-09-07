import { useEffect, useState } from 'react'
import { AppState } from 'react-native'

/** Relative labels are minute-grained, so there is nothing to gain from a faster clock. */
const TICK_MS = 60_000

function currentTick(): number {
  return Math.floor(Date.now() / TICK_MS)
}

/**
 * Minute counter for relative timestamps ("13m", "9h").
 *
 * Rows that render a relative label have no reason of their own to re-render:
 * a thread nobody has touched keeps the same summary object for hours, and the
 * sidebar's memoized rows plus the closed-drawer freeze mean React can leave a
 * cell untouched just as long. The label then stays at whatever the age was
 * when it was last computed — the sidebar showed "13m" next to a thread that
 * had been idle for seven hours. Threading this counter through the row props
 * gives those cells a reason to repaint on the same cadence the labels change.
 *
 * Timers are unreliable while the app is backgrounded (and pointless: nothing
 * is on screen), so the interval is torn down on the way out and the counter
 * re-reads the clock on the way back in, which is exactly when a stale label
 * would otherwise be visible.
 */
export function useRelativeTimeTick(): number {
  const [tick, setTick] = useState(currentTick)

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null

    const start = () => {
      setTick(currentTick())
      interval ??= setInterval(() => setTick(currentTick()), TICK_MS)
    }
    const stop = () => {
      if (interval === null) return
      clearInterval(interval)
      interval = null
    }

    if (AppState.currentState !== 'background') start()
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') start()
      else if (status === 'background') stop()
    })

    return () => {
      stop()
      subscription.remove()
    }
  }, [])

  return tick
}
