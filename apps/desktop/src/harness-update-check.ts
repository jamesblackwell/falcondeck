import type { HarnessSummary, HarnessesOverview } from '@falcondeck/client-core'

export const HARNESS_UPDATE_CHECK_DELAY_MS = 30_000
export const HARNESS_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000

const LAST_CHECK_STORAGE_KEY = 'falcondeck.harness-updates.last-check-at'

type HarnessUpdateApi = {
  refreshHarnesses(options?: { includeLatest?: boolean }): Promise<HarnessesOverview>
}

type HarnessUpdateCheckOptions = {
  api: HarnessUpdateApi
  onUpdatesAvailable: (harnesses: HarnessSummary[]) => void
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  now?: () => number
  setTimer?: (callback: () => void, delay: number) => number
  clearTimer?: (timer: number) => void
}

function readLastCheck(storage: Pick<Storage, 'getItem'>): number | null {
  try {
    const value = Number(storage.getItem(LAST_CHECK_STORAGE_KEY))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function writeLastCheck(storage: Pick<Storage, 'setItem'>, checkedAt: number): void {
  try {
    storage.setItem(LAST_CHECK_STORAGE_KEY, String(checkedAt))
  } catch {
    // Storage can be unavailable in privacy-restricted webviews. The check is
    // still useful for this launch even when its cross-launch throttle cannot
    // be persisted.
  }
}

function isCheckDue(storage: Pick<Storage, 'getItem'>, now: number): boolean {
  const lastCheck = readLastCheck(storage)
  return lastCheck == null || now - lastCheck >= HARNESS_UPDATE_CHECK_INTERVAL_MS
}

/**
 * Schedules the local harness version check after startup has settled. The
 * timestamp is claimed immediately before network work starts so failed
 * registries do not cause a request storm on every launch.
 */
export function scheduleHarnessUpdateCheck({
  api,
  onUpdatesAvailable,
  storage = window.localStorage,
  now = Date.now,
  setTimer = window.setTimeout,
  clearTimer = window.clearTimeout,
}: HarnessUpdateCheckOptions): () => void {
  if (!isCheckDue(storage, now())) return () => {}

  const timer = setTimer(() => {
    const checkedAt = now()
    // Re-check after the delay in case another window claimed the daily check.
    if (!isCheckDue(storage, checkedAt)) return
    writeLastCheck(storage, checkedAt)

    void api
      .refreshHarnesses({ includeLatest: true })
      .then((overview) => {
        const updates = overview.harnesses.filter(
          (harness) => harness.installed && harness.update_available === true,
        )
        if (updates.length > 0) onUpdatesAvailable(updates)
      })
      .catch(() => {
        // Background discovery is best-effort. Manual checks in Settings keep
        // their visible error path and remain available at any time.
      })
  }, HARNESS_UPDATE_CHECK_DELAY_MS)

  return () => clearTimer(timer)
}
