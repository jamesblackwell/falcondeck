import { afterEach, describe, expect, it, vi } from 'vitest'

// The real module `require`s the vendored engine, which Metro copies in at
// bundle time and is therefore absent under Vitest.
vi.mock('./mermaidAsset', () => ({ default: 1 }))

import { __resetAssetMock, __setAssetLocalUri } from 'expo-asset'
import { __setFileText, resetFileSystemMock } from 'expo-file-system'

import {
  loadMermaidBrowserSource,
  setMermaidAssetLoader,
} from './mermaidEngine'

describe('loadMermaidBrowserSource', () => {
  afterEach(() => {
    setMermaidAssetLoader(null)
    __resetAssetMock()
    resetFileSystemMock()
  })

  it('uses an injected loader and caches the result', async () => {
    let calls = 0
    setMermaidAssetLoader(async () => {
      calls += 1
      return `engine-${calls}`
    })
    await expect(loadMermaidBrowserSource()).resolves.toBe('engine-1')
    await expect(loadMermaidBrowserSource()).resolves.toBe('engine-1')
    expect(calls).toBe(1)
  })

  it('clears a failed load so the next attempt can retry', async () => {
    setMermaidAssetLoader(async () => {
      throw new Error('offline')
    })
    await expect(loadMermaidBrowserSource()).rejects.toThrow('offline')

    setMermaidAssetLoader(async () => 'recovered')
    await expect(loadMermaidBrowserSource()).resolves.toBe('recovered')
  })

  it('reads the bundled mermaid asset through expo-asset', async () => {
    setMermaidAssetLoader(null)
    await expect(loadMermaidBrowserSource()).resolves.toContain('window.mermaid')
  })

  it('fails when the bundled asset has no local uri', async () => {
    setMermaidAssetLoader(null)
    __setAssetLocalUri(null)
    await expect(loadMermaidBrowserSource()).rejects.toThrow(
      'Mermaid engine is unavailable',
    )
  })

  it('surfaces file read failures', async () => {
    setMermaidAssetLoader(null)
    __setFileText(async () => {
      throw new Error('read failed')
    })
    await expect(loadMermaidBrowserSource()).rejects.toThrow('read failed')
  })
})
