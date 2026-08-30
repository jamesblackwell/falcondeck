import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetAllStores } from 'react-native-mmkv'

describe('developer settings store', () => {
  beforeEach(() => {
    __resetAllStores()
    vi.resetModules()
  })

  it('does not enable the performance overlay from a non-boolean cache value', async () => {
    const { setJson } = await import('@/storage/mmkv')
    setJson('mobile.dev-settings', { showPerfOverlay: 'false' })
    const { useDevSettingsStore } = await import('./dev-settings-store')

    expect(useDevSettingsStore.getState().showPerfOverlay).toBe(false)
  })
})
