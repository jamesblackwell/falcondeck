import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchWithTimeout } from './transport-timeout'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('fetchWithTimeout', () => {
  it('aborts a request that never settles', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
    })

    const request = fetchWithTimeout('https://relay.example/ws-ticket', undefined, 100)
    const rejection = expect(request).rejects.toThrow('Request timed out')
    await vi.advanceTimersByTimeAsync(100)

    await rejection
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it('forwards caller cancellation without reporting a timeout', async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
    })

    const request = fetchWithTimeout(
      'https://relay.example/ws-ticket',
      { signal: caller.signal },
      100,
    )
    caller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(100)
  })

  it('honours a signal that was aborted before the request started', async () => {
    const caller = new AbortController()
    caller.abort()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      expect(init?.signal?.aborted).toBe(true)
      return Promise.reject(new DOMException('Aborted', 'AbortError'))
    })

    await expect(
      fetchWithTimeout('https://relay.example/ws-ticket', { signal: caller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('detaches the caller abort listener after a successful request', async () => {
    const caller = new AbortController()
    const removeListener = vi.spyOn(caller.signal, 'removeEventListener')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    await fetchWithTimeout('https://relay.example/ws-ticket', { signal: caller.signal })

    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
