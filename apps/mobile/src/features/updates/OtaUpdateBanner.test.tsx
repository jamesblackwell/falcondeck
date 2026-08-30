import React from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cleanup, renderComponent, textOf } from '@/test/render'

const updatesMock = vi.hoisted(() => ({
  state: {
    isUpdateAvailable: false,
    isUpdatePending: false,
    isChecking: false,
    isDownloading: false,
    isRestarting: false,
    downloadError: undefined as Error | undefined,
  },
  checkForUpdateAsync: vi.fn(),
  fetchUpdateAsync: vi.fn(),
  reloadAsync: vi.fn(),
}))

vi.mock('expo-updates', () => ({
  isEnabled: true,
  useUpdates: () => updatesMock.state,
  checkForUpdateAsync: updatesMock.checkForUpdateAsync,
  fetchUpdateAsync: updatesMock.fetchUpdateAsync,
  reloadAsync: updatesMock.reloadAsync,
}))

import { OtaUpdateBanner } from './OtaUpdateBanner'

beforeEach(() => {
  updatesMock.state.isUpdateAvailable = false
  updatesMock.state.isUpdatePending = false
  updatesMock.state.isChecking = false
  updatesMock.state.isDownloading = false
  updatesMock.state.isRestarting = false
  updatesMock.state.downloadError = undefined
  updatesMock.checkForUpdateAsync.mockReset().mockResolvedValue({
    isAvailable: true,
    isRollBackToEmbedded: false,
  })
  updatesMock.fetchUpdateAsync.mockReset().mockResolvedValue({
    isNew: true,
    isRollBackToEmbedded: false,
  })
  updatesMock.reloadAsync.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('OtaUpdateBanner', () => {
  it('stays hidden when the running bundle is current', () => {
    expect(renderComponent(<OtaUpdateBanner />).toJSON()).toBeNull()
  })

  it('offers to refresh when an update is available', () => {
    updatesMock.state.isUpdateAvailable = true
    const renderer = renderComponent(<OtaUpdateBanner />)

    expect(textOf(renderer)).toContain('Update available')
    expect(textOf(renderer)).toContain('Tap to refresh FalconDeck')
    expect(renderer.root.findByType('Pressable' as never).props.accessibilityRole).toBe('button')
  })

  it('checks for updates when the app returns to the foreground', () => {
    let onAppStateChange: ((state: AppStateStatus) => void) | undefined
    vi.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      onAppStateChange = listener
      return { remove: vi.fn() }
    })
    renderComponent(<OtaUpdateBanner />)

    act(() => {
      onAppStateChange?.('background')
      onAppStateChange?.('active')
    })

    expect(updatesMock.checkForUpdateAsync).toHaveBeenCalledOnce()
  })

  it('downloads an available update and reloads the app on tap', async () => {
    updatesMock.state.isUpdateAvailable = true
    const renderer = renderComponent(<OtaUpdateBanner />)

    await act(async () => {
      renderer.root.findByType('Pressable' as never).props.onPress()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(updatesMock.fetchUpdateAsync).toHaveBeenCalledOnce()
    expect(updatesMock.reloadAsync).toHaveBeenCalledOnce()
  })

  it('reloads an already-downloaded update without fetching it again', async () => {
    updatesMock.state.isUpdatePending = true
    const renderer = renderComponent(<OtaUpdateBanner />)

    expect(textOf(renderer)).toContain('Update ready')
    await act(async () => {
      renderer.root.findByType('Pressable' as never).props.onPress()
      await Promise.resolve()
    })

    expect(updatesMock.fetchUpdateAsync).not.toHaveBeenCalled()
    expect(updatesMock.reloadAsync).toHaveBeenCalledOnce()
  })

  it('shows progress and prevents duplicate taps while downloading', () => {
    updatesMock.state.isUpdateAvailable = true
    updatesMock.state.isDownloading = true
    const renderer = renderComponent(<OtaUpdateBanner />)
    const banner = renderer.root.findByType('Pressable' as never)

    expect(textOf(renderer)).toContain('Downloading update…')
    expect(banner.props.disabled).toBe(true)
    expect(banner.props.accessibilityState).toEqual({ disabled: true })
  })

  it('keeps a failed update visible as a retry action', async () => {
    updatesMock.state.isUpdateAvailable = true
    updatesMock.fetchUpdateAsync.mockRejectedValueOnce(new Error('offline'))
    const renderer = renderComponent(<OtaUpdateBanner />)

    await act(async () => {
      renderer.root.findByType('Pressable' as never).props.onPress()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(textOf(renderer)).toContain('Update failed')
    expect(textOf(renderer)).toContain("Couldn't refresh FalconDeck. Tap to try again.")
    expect(renderer.root.findByType('Pressable' as never).props.disabled).toBe(false)
  })
})
