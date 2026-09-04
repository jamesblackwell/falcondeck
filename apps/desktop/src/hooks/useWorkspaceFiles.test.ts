import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkspaceFiles } from './useWorkspaceFiles'

function makeApi(files: string[] = []) {
  return {
    workspaceFiles: vi.fn(async (_workspaceId: string, _threadId?: string | null, search?: string | null) => ({
      files: search ? files.filter((path) => path.includes(search)) : files,
      truncated: false,
    })),
  }
}

describe('useWorkspaceFiles', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the query to the daemon instead of filtering the capped listing', async () => {
    const api = makeApi(['README.md', 'docs/qa/2026-09-mobile-web-audit.md'])
    const { rerender, result } = renderHook(
      ({ query }) => useWorkspaceFiles(api, 'ws-1', null, true, query),
      { initialProps: { query: '' } },
    )
    await waitFor(() => expect(result.current.result?.files).toHaveLength(2))
    expect(api.workspaceFiles).toHaveBeenCalledWith('ws-1', null, null)

    rerender({ query: 'mobile-web-audit' })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })

    await waitFor(() =>
      expect(api.workspaceFiles).toHaveBeenLastCalledWith('ws-1', null, 'mobile-web-audit'),
    )
    await waitFor(() =>
      expect(result.current.result?.files).toEqual(['docs/qa/2026-09-mobile-web-audit.md']),
    )
  })

  it('debounces a burst of typing into one search', async () => {
    const api = makeApi(['docs/qa/audit.md'])
    const { rerender } = renderHook(
      ({ query }) => useWorkspaceFiles(api, 'ws-1', null, true, query),
      { initialProps: { query: '' } },
    )
    await waitFor(() => expect(api.workspaceFiles).toHaveBeenCalledTimes(1))

    for (const query of ['a', 'au', 'aud', 'audi', 'audit']) {
      rerender({ query })
    }
    await act(async () => {
      vi.advanceTimersByTime(200)
    })

    await waitFor(() => expect(api.workspaceFiles).toHaveBeenCalledTimes(2))
    expect(api.workspaceFiles).toHaveBeenLastCalledWith('ws-1', null, 'audit')
  })

  it('keeps the previous rows on screen while the next search runs', async () => {
    const api = makeApi(['docs/qa/audit.md'])
    const { rerender, result } = renderHook(
      ({ query }) => useWorkspaceFiles(api, 'ws-1', null, true, query),
      { initialProps: { query: '' } },
    )
    await waitFor(() => expect(result.current.result?.files).toHaveLength(1))

    rerender({ query: 'audit' })
    expect(result.current.result?.files).toEqual(['docs/qa/audit.md'])
  })
})
