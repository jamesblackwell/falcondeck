const PERFORMANCE_STORAGE_KEY = 'falcondeck.performance'

/**
 * Opt-in User Timing instrumentation for packaged builds. Enable with
 * `localStorage.setItem('falcondeck.performance', '1')` and restart, then read
 * `performance.getEntriesByType('measure')` from Web Inspector.
 */
export const performanceTracingEnabled = (() => {
  try {
    return window.localStorage.getItem(PERFORMANCE_STORAGE_KEY) === '1'
  } catch {
    return false
  }
})()

export function recordPerformance(
  name: string,
  startedAt: number,
  detail?: Record<string, unknown>,
) {
  if (!performanceTracingEnabled) return
  try {
    performance.measure(name, {
      start: startedAt,
      end: performance.now(),
      detail,
    })
  } catch {
    // Diagnostics must never affect the interaction being measured. Older
    // WebKit versions may not support the options/detail overload.
  }
}
