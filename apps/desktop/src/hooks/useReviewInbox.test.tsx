import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Review } from '@falcondeck/client-core'

import { useReviewInbox } from './useReviewInbox'

vi.mock('./useControlStateEvents', () => ({ useControlStateEvents: vi.fn() }))

const row = (id: string, status: Review['status'] = 'open') => ({ id, status, title: id }) as unknown as Review

describe('useReviewInbox', () => {
  beforeEach(() => localStorage.clear())

  it('does not fetch when the inbox is off', async () => {
    const api = { listReviews: vi.fn(async () => []) }
    const { result } = renderHook(() => useReviewInbox({ api, baseUrl: 'http://x', enabled: false }))
    expect(api.listReviews).not.toHaveBeenCalled()
    expect(result.current.openCount).toBe(0)
  })

  it('counts open reviews and keeps the backlog quiet', async () => {
    const api = { listReviews: vi.fn(async () => [row('R-1'), row('R-2'), row('R-3', 'approved')]) }
    const onNew = vi.fn()
    const { result } = renderHook(() => useReviewInbox({ api, baseUrl: 'http://x', enabled: true, onNewReviews: onNew }))
    await waitFor(() => expect(result.current.openCount).toBe(2))
    expect(api.listReviews).toHaveBeenCalledWith({ include_closed: true })
    expect(onNew).not.toHaveBeenCalled()
  })

  it('reports only reviews that arrive after the first load', async () => {
    let rows = [row('R-1')]
    const api = { listReviews: vi.fn(async () => rows) }
    const onNew = vi.fn()
    const { result } = renderHook(() => useReviewInbox({ api, baseUrl: 'http://x', enabled: true, onNewReviews: onNew }))
    await waitFor(() => expect(result.current.openCount).toBe(1))
    rows = [row('R-1'), row('R-2')]
    await act(async () => result.current.refresh())
    expect(onNew).toHaveBeenCalledTimes(1)
    expect(onNew.mock.calls[0][0].map((r: Review) => r.id)).toEqual(['R-2'])
    await act(async () => result.current.refresh())
    expect(onNew).toHaveBeenCalledTimes(1)
  })

  it('catches a review that arrived while the app was closed, once', async () => {
    localStorage.setItem('falcondeck.reviews.alerted', JSON.stringify(['R-1']))
    const api = { listReviews: vi.fn(async () => [row('R-1'), row('R-2')]) }
    const onNew = vi.fn()
    const { result, unmount } = renderHook(() =>
      useReviewInbox({ api, baseUrl: 'http://127.0.0.1:1', enabled: true, onNewReviews: onNew }),
    )
    await waitFor(() => expect(result.current.openCount).toBe(2))
    expect(onNew.mock.calls[0][0].map((r: Review) => r.id)).toEqual(['R-2'])
    unmount()
    onNew.mockClear()
    const relaunched = renderHook(() =>
      useReviewInbox({ api, baseUrl: 'http://127.0.0.1:1', enabled: true, onNewReviews: onNew }),
    )
    await waitFor(() => expect(relaunched.result.current.openCount).toBe(2))
    expect(onNew).not.toHaveBeenCalled()
  })

  it('keeps drafts across a refetch and clears them on demand', async () => {
    const api = { listReviews: vi.fn(async () => [row('R-1')]) }
    const { result } = renderHook(() => useReviewInbox({ api, baseUrl: 'http://x', enabled: true }))
    await waitFor(() => expect(result.current.openCount).toBe(1))
    act(() => result.current.updateDraft('R-1', (d) => ({ ...d, overall: { note: 'hi' } })))
    await act(async () => result.current.refresh())
    expect(result.current.drafts['R-1'].overall?.note).toBe('hi')
    act(() => result.current.clearDraft('R-1'))
    expect(result.current.drafts['R-1']).toBeUndefined()
  })

  it('surfaces a load error', async () => {
    const api = { listReviews: vi.fn(async () => { throw new Error('down') }) }
    const { result } = renderHook(() => useReviewInbox({ api, baseUrl: 'http://x', enabled: true }))
    await waitFor(() => expect(result.current.error).toBe('down'))
  })
})
