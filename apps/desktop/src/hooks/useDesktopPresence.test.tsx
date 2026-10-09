import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { useDesktopPresence } from './useDesktopPresence'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))

describe('desktop presence', () => {
  const api = { setClientActivity: vi.fn().mockResolvedValue(undefined) }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'))
    vi.clearAllMocks()
    api.setClientActivity.mockReset().mockResolvedValue(undefined)
    delete window.__TAURI_INTERNALS__
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.mocked(invoke).mockReset().mockResolvedValue(null)
    vi.mocked(getCurrentWindow).mockReturnValue({
      isFocused: vi.fn().mockResolvedValue(false),
      onFocusChanged: vi.fn().mockResolvedValue(vi.fn()),
    } as unknown as ReturnType<typeof getCurrentWindow>)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete window.__TAURI_INTERNALS__
  })

  it('keeps presence after switching windows, then expires after two minutes', async () => {
    const { result } = renderHook(() => useDesktopPresence(api))
    act(() => window.dispatchEvent(new Event('blur')))
    await act(() => vi.advanceTimersByTimeAsync(90_000))
    expect(result.current).toEqual({ windowFocused: false, desktopPresent: true })
    expect(api.setClientActivity).toHaveBeenLastCalledWith(true)
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(result.current.desktopPresent).toBe(false)
    expect(api.setClientActivity).toHaveBeenLastCalledWith(false)
  })

  it('does not keep an unattended focused window present indefinitely', async () => {
    const { result } = renderHook(() => useDesktopPresence(api))
    await act(() => vi.advanceTimersByTimeAsync(120_000))
    expect(result.current).toEqual({ windowFocused: true, desktopPresent: false })
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })))
    expect(result.current.desktopPresent).toBe(true)
    await act(() => vi.advanceTimersByTimeAsync(15_000))
    expect(api.setClientActivity).toHaveBeenLastCalledWith(true)
  })

  it('does not assume a visible window has focus on startup', () => {
    vi.mocked(document.hasFocus).mockReturnValue(false)
    const { result } = renderHook(() => useDesktopPresence(api))
    expect(result.current.windowFocused).toBe(false)
    expect(api.setClientActivity).toHaveBeenLastCalledWith(false)
  })

  it('uses Mac activity in other apps independently of FalconDeck focus', async () => {
    window.__TAURI_INTERNALS__ = {}
    vi.mocked(invoke).mockResolvedValue(true)
    const { result } = renderHook(() => useDesktopPresence(api))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(result.current).toEqual({ windowFocused: false, desktopPresent: true })
    await act(() => vi.advanceTimersByTimeAsync(180_000))
    expect(result.current.desktopPresent).toBe(true)
    expect(api.setClientActivity).not.toHaveBeenCalled()
  })

  it('uses native idle time even when the Mac window remains focused', async () => {
    window.__TAURI_INTERNALS__ = {}
    vi.mocked(invoke).mockResolvedValue(false)
    vi.mocked(getCurrentWindow).mockReturnValue({
      isFocused: vi.fn().mockResolvedValue(true),
      onFocusChanged: vi.fn().mockResolvedValue(vi.fn()),
    } as unknown as ReturnType<typeof getCurrentWindow>)
    const { result } = renderHook(() => useDesktopPresence(api))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(result.current).toEqual({ windowFocused: true, desktopPresent: false })
    expect(api.setClientActivity).not.toHaveBeenCalled()
  })

  it('does not publish a late native result after unmount', async () => {
    window.__TAURI_INTERNALS__ = {}
    let resolve!: (value: boolean | null) => void
    vi.mocked(invoke).mockImplementation(() => new Promise((done) => { resolve = done }))
    const { unmount } = renderHook(() => useDesktopPresence(api))
    unmount()
    await act(async () => resolve(null))
    expect(api.setClientActivity.mock.calls).toEqual([[false]])
  })
})
