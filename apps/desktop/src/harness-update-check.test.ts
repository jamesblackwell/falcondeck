import { describe, expect, it, vi } from 'vitest'

import {
  HARNESS_UPDATE_CHECK_DELAY_MS,
  HARNESS_UPDATE_CHECK_INTERVAL_MS,
  scheduleHarnessUpdateCheck,
} from './harness-update-check'

function memoryStorage(initialValue?: number) {
  let value = initialValue == null ? null : String(initialValue)
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next
    }),
  }
}

function overview(updateAvailable: boolean) {
  return {
    host: 'local',
    harnesses: [
      {
        id: 'codex',
        label: 'Codex',
        kind: 'builtin' as const,
        bin: 'codex',
        resolved_path: '/usr/local/bin/codex',
        installed: true,
        install_state: 'installed' as const,
        executable_source: 'path' as const,
        version: '1.0.0',
        latest_version: updateAvailable ? '1.1.0' : '1.0.0',
        update_available: updateAvailable,
        version_state: updateAvailable ? ('update_available' as const) : ('current' as const),
        install_source: 'npm' as const,
        upgrade_command: 'npm install -g @openai/codex@latest',
        account_status: null,
        auth_verdict: 'unsupported' as const,
        compatibility_verdict: 'unknown' as const,
        provider_usage_state: 'unsupported' as const,
      },
    ],
  }
}

describe('scheduleHarnessUpdateCheck', () => {
  it('waits for startup to settle, claims the daily check, and reports updates', async () => {
    vi.useFakeTimers()
    const storage = memoryStorage()
    const api = { refreshHarnesses: vi.fn().mockResolvedValue(overview(true)) }
    const onUpdatesAvailable = vi.fn()

    scheduleHarnessUpdateCheck({ api, onUpdatesAvailable, storage, now: () => 1_000_000 })

    await vi.advanceTimersByTimeAsync(HARNESS_UPDATE_CHECK_DELAY_MS - 1)
    expect(api.refreshHarnesses).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(storage.setItem).toHaveBeenCalledWith(
      'falcondeck.harness-updates.last-check-at',
      '1000000',
    )
    expect(api.refreshHarnesses).toHaveBeenCalledWith({ includeLatest: true })
    expect(onUpdatesAvailable).toHaveBeenCalledWith(overview(true).harnesses)
    vi.useRealTimers()
  })

  it('does not schedule another check inside the daily interval', async () => {
    vi.useFakeTimers()
    const now = HARNESS_UPDATE_CHECK_INTERVAL_MS * 2
    const api = { refreshHarnesses: vi.fn().mockResolvedValue(overview(true)) }

    scheduleHarnessUpdateCheck({
      api,
      onUpdatesAvailable: vi.fn(),
      storage: memoryStorage(now - HARNESS_UPDATE_CHECK_INTERVAL_MS + 1),
      now: () => now,
    })

    await vi.advanceTimersByTimeAsync(HARNESS_UPDATE_CHECK_DELAY_MS)
    expect(api.refreshHarnesses).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('stays quiet when everything is current or the background request fails', async () => {
    vi.useFakeTimers()
    const onUpdatesAvailable = vi.fn()
    const currentApi = { refreshHarnesses: vi.fn().mockResolvedValue(overview(false)) }

    scheduleHarnessUpdateCheck({
      api: currentApi,
      onUpdatesAvailable,
      storage: memoryStorage(),
      now: () => 3_000_000,
    })
    await vi.advanceTimersByTimeAsync(HARNESS_UPDATE_CHECK_DELAY_MS)

    const failingApi = { refreshHarnesses: vi.fn().mockRejectedValue(new Error('offline')) }
    scheduleHarnessUpdateCheck({
      api: failingApi,
      onUpdatesAvailable,
      storage: memoryStorage(),
      now: () => 4_000_000,
    })
    await vi.advanceTimersByTimeAsync(HARNESS_UPDATE_CHECK_DELAY_MS)

    expect(onUpdatesAvailable).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
