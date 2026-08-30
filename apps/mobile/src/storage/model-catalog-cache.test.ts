import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetAllStores } from 'react-native-mmkv'

describe('model catalog cache', () => {
  beforeEach(() => {
    __resetAllStores()
    vi.resetModules()
  })

  it('treats a null entries map as a corrupt cache instead of crashing', async () => {
    const { setJson } = await import('./mmkv')
    setJson('mobile.model-catalog-cache', { version: 1, entries: null })
    const { loadCachedModels } = await import('./model-catalog-cache')

    expect(() => loadCachedModels('workspace-1', 'codex')).not.toThrow()
    expect(loadCachedModels('workspace-1', 'codex')).toEqual([])
  })

  it('does not expose a non-array catalog value to picker consumers', async () => {
    const { setJson } = await import('./mmkv')
    setJson('mobile.model-catalog-cache', {
      version: 1,
      entries: { 'workspace-1:codex': 'not-a-model-list' },
    })
    const { loadCachedModels } = await import('./model-catalog-cache')

    expect(loadCachedModels('workspace-1', 'codex')).toEqual([])
  })
})
