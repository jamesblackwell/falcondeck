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
})
