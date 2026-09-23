import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppUpdater } from './useAppUpdater'

const { check, getVersion } = vi.hoisted(() => ({ check: vi.fn(), getVersion: vi.fn() }))

vi.mock('@tauri-apps/plugin-updater', () => ({ check }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion }))
vi.mock('../api', () => ({ isTauriDesktop: () => true, restartDesktopApp: vi.fn() }))

describe('useAppUpdater', () => {
  beforeEach(() => {
    vi.stubEnv('DEV', false)
    getVersion.mockResolvedValue('0.1.1')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('checks, verifies and installs an available release, then leaves it ready to restart', async () => {
    const download = vi.fn(async (onEvent: (event: { event: string; data?: Record<string, number> }) => void) => {
      onEvent({ event: 'Started', data: { contentLength: 100 } })
      onEvent({ event: 'Progress', data: { chunkLength: 100 } })
    })
    const install = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    check.mockResolvedValue({ version: '0.1.2', body: 'Update notes', download, install, close })

    const hook = renderHook(() => useAppUpdater())
    await waitFor(() => expect(hook.result.current.state.currentVersion).toBe('0.1.1'))
    await act(async () => {
      expect(await hook.result.current.checkForUpdates()).toEqual({ kind: 'available' })
    })
    expect(hook.result.current.state.availableVersion).toBe('0.1.2')

    await act(async () => {
      expect(await hook.result.current.checkForUpdates()).toEqual({ kind: 'available' })
    })
    expect(check).toHaveBeenCalledOnce()

    await act(async () => {
      await hook.result.current.downloadAndInstall()
    })
    expect(download).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(hook.result.current.state.status).toBe('downloaded')
    expect(hook.result.current.progressPercent).toBe(100)
    hook.unmount()
  })
})
