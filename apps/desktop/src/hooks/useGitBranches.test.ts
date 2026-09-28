import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { GitBranchesResponse } from '@falcondeck/client-core'

import { useGitBranches } from './useGitBranches'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function branches(current: string): GitBranchesResponse {
  return { current, branches: ['main', 'feature'] }
}

describe('useGitBranches', () => {
  it('does not let an older branch listing replace a completed checkout', async () => {
    const staleListing = deferred<GitBranchesResponse>()
    const api = {
      gitBranches: vi.fn()
        .mockResolvedValueOnce(branches('main'))
        .mockReturnValueOnce(staleListing.promise),
      gitStatus: vi.fn().mockResolvedValue({ branch: 'main', entries: [] }),
      gitCheckout: vi.fn().mockResolvedValue(branches('feature')),
    }
    const { result, rerender } = renderHook(
      ({ refreshTrigger }) => useGitBranches(api, 'workspace', refreshTrigger),
      { initialProps: { refreshTrigger: 0 } },
    )
    await waitFor(() => expect(result.current.branches?.current).toBe('main'))

    rerender({ refreshTrigger: 1 })
    await waitFor(() => expect(api.gitBranches).toHaveBeenCalledTimes(2))
    await act(async () => { await result.current.checkout('feature', false) })
    expect(result.current.branches?.current).toBe('feature')

    await act(async () => { staleListing.resolve(branches('main')) })
    expect(result.current.branches?.current).toBe('feature')
  })

  it('does not publish a checkout from the previous workspace', async () => {
    const oldCheckout = deferred<GitBranchesResponse>()
    const api = {
      gitBranches: vi.fn(async (workspaceId: string) => branches(workspaceId)),
      gitStatus: vi.fn().mockResolvedValue({ branch: 'main', entries: [] }),
      gitCheckout: vi.fn().mockReturnValue(oldCheckout.promise),
    }
    const { result, rerender } = renderHook(
      ({ workspaceId }) => useGitBranches(api, workspaceId, 0),
      { initialProps: { workspaceId: 'first' } },
    )
    await waitFor(() => expect(result.current.branches?.current).toBe('first'))

    let checkout!: Promise<void>
    act(() => { checkout = result.current.checkout('feature', false) })
    rerender({ workspaceId: 'second' })
    await waitFor(() => expect(result.current.branches?.current).toBe('second'))
    expect(result.current.isCheckoutPending).toBe(false)

    await act(async () => {
      oldCheckout.resolve(branches('feature'))
      await checkout
    })
    expect(result.current.branches?.current).toBe('second')
  })
})
