import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useWorkspaceFileIndex } from './useWorkspaceFileIndex'

function apiWith(files: string[], truncated = false) {
  return {
    workspaceFiles: vi.fn(async () => ({ files, truncated })),
  }
}

describe('useWorkspaceFileIndex', () => {
  it('fetches the listing on first lookup and answers synchronously after', async () => {
    const api = apiWith(['src/app.ts'])
    const { result } = renderHook(() => useWorkspaceFileIndex(api, 'ws', null, 0))

    const first = result.current.resolve?.('src/app.ts')
    expect(first).toBeInstanceOf(Promise)
    await expect(first).resolves.toBe(true)
    expect(api.workspaceFiles).toHaveBeenCalledTimes(1)

    await waitFor(() => expect(result.current.version).toBeGreaterThan(0))
    expect(result.current.resolve?.('src/app.ts')).toBe(true)
    expect(result.current.resolve?.('src/missing.ts')).toBe(false)
    expect(api.workspaceFiles).toHaveBeenCalledTimes(1)
  })

  it('cannot rule a path out when the listing was truncated', async () => {
    const api = apiWith(['a.ts'], true)
    const { result } = renderHook(() => useWorkspaceFileIndex(api, 'ws', null, 0))
    await expect(result.current.resolve?.('zzz/late.ts')).resolves.toBeNull()
  })

  it('reloads on a git refresh only once someone has asked', async () => {
    const api = apiWith(['src/app.ts'])
    const { result, rerender } = renderHook(
      ({ trigger }) => useWorkspaceFileIndex(api, 'ws', null, trigger),
      { initialProps: { trigger: 0 } },
    )
    rerender({ trigger: 1 })
    expect(api.workspaceFiles).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.resolve?.('src/app.ts')
    })
    rerender({ trigger: 2 })
    await waitFor(() => expect(api.workspaceFiles).toHaveBeenCalledTimes(2))
  })

  it('offers no resolver without a workspace and forgets the listing on switch', async () => {
    const api = apiWith(['src/app.ts'])
    const { result, rerender } = renderHook(
      ({ workspaceId }: { workspaceId: string | null }) =>
        useWorkspaceFileIndex(api, workspaceId, null, 0),
      { initialProps: { workspaceId: null as string | null } },
    )
    expect(result.current.resolve).toBeNull()

    rerender({ workspaceId: 'ws' })
    await act(async () => {
      await result.current.resolve?.('src/app.ts')
    })
    rerender({ workspaceId: 'other' })
    expect(result.current.resolve?.('src/app.ts')).toBeInstanceOf(Promise)
  })
})
