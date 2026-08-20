import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DaemonSnapshot, EventEnvelope, ThreadDetail } from '@falcondeck/client-core'

import { useDaemonConnection } from './useDaemonConnection'

const mocks = vi.hoisted(() => ({
  detectApiBaseUrl: vi.fn(),
  snapshot: vi.fn(),
  remoteStatus: vi.fn(),
  threadDetail: vi.fn(),
  eventHandler: null as ((event: EventEnvelope) => void) | null,
  sockets: [] as Array<{
    close: ReturnType<typeof vi.fn>
    onopen: (() => void) | null
    onmessage: (() => void) | null
    onerror: (() => void) | null
    onclose: (() => void) | null
  }>,
}))

vi.mock('../api', () => ({
  detectApiBaseUrl: mocks.detectApiBaseUrl,
}))

vi.mock('@falcondeck/client-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@falcondeck/client-core')>()
  return {
    ...actual,
    createDaemonApiClient: () => ({
      snapshot: mocks.snapshot,
      remoteStatus: mocks.remoteStatus,
      threadDetail: mocks.threadDetail,
      connectEvents: (onEvent: (event: EventEnvelope) => void) => {
        mocks.eventHandler = onEvent
        const socket = {
          close: vi.fn(),
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
        }
        mocks.sockets.push(socket)
        return socket
      },
    }),
  }
})

function daemonSnapshot(status: 'connecting' | 'ready'): DaemonSnapshot {
  return {
    daemon: {},
    preferences: {},
    workspaces: [
      {
        id: 'workspace-1',
        path: '/repo',
        status,
        current_thread_id: 'thread-1',
      },
    ],
    threads: [
      {
        id: 'thread-1',
        workspace_id: 'workspace-1',
        provider: 'claude',
        title: 'Restored Claude thread',
        updated_at: '2026-08-08T12:00:00Z',
      },
    ],
    interactive_requests: [],
  } as unknown as DaemonSnapshot
}

function hydratedDetail(): ThreadDetail {
  return {
    workspace: daemonSnapshot('ready').workspaces[0],
    thread: daemonSnapshot('ready').threads[0],
    items: [{ id: 'message-1', text: 'restored' }],
  } as unknown as ThreadDetail
}

describe('useDaemonConnection thread restoration', () => {
  beforeEach(() => {
    window.localStorage.clear()
    mocks.detectApiBaseUrl.mockReset().mockResolvedValue('http://127.0.0.1:1234')
    mocks.snapshot.mockReset().mockResolvedValue(daemonSnapshot('connecting'))
    mocks.remoteStatus.mockReset().mockResolvedValue({ status: 'inactive' })
    mocks.threadDetail.mockReset().mockResolvedValue(hydratedDetail())
    mocks.eventHandler = null
    mocks.sockets = []
  })

  it('opens the local daemon even when remote relay status is slow', async () => {
    mocks.remoteStatus.mockImplementation(() => new Promise(() => {}))

    const { result } = renderHook(() => useDaemonConnection())

    await waitFor(() => expect(result.current.connectionState).toBe('ready'))
    expect(result.current.snapshot).not.toBeNull()
    expect(result.current.remoteStatus).toBeNull()
  })

  it('waits for workspace hydration before fetching a restored thread detail', async () => {
    const { result } = renderHook(() => useDaemonConnection())

    await waitFor(() => expect(result.current.connectionState).toBe('ready'))
    expect(mocks.threadDetail).not.toHaveBeenCalled()

    act(() => result.current.setSnapshot(daemonSnapshot('ready')))

    await waitFor(() =>
      expect(mocks.threadDetail).toHaveBeenCalledWith('workspace-1', 'thread-1', {
        mode: 'tail',
        limit: 150,
      }),
    )
    await waitFor(() => expect(result.current.threadDetail?.items).toHaveLength(1))
  })

  it('clears a previous detail error when starting a new thread', async () => {
    mocks.threadDetail.mockRejectedValueOnce(new Error('old thread failed'))
    const { result } = renderHook(() => useDaemonConnection())

    await waitFor(() => expect(result.current.connectionState).toBe('ready'))
    act(() => result.current.setSnapshot(daemonSnapshot('ready')))
    await waitFor(() =>
      expect(result.current.threadDetailError).toBe('old thread failed'),
    )

    act(() => result.current.setSelectedThreadId(null))

    await waitFor(() => {
      expect(result.current.selectedThreadId).toBeNull()
      expect(result.current.threadDetailError).toBeNull()
    })
  })

  it('corrects a thread left spinning after its terminal update went missing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { result } = renderHook(() => useDaemonConnection())
      await waitFor(() => expect(result.current.connectionState).toBe('ready'))

      const live = daemonSnapshot('ready')
      live.threads[0] = { ...live.threads[0], status: 'running' }
      act(() => result.current.setSnapshot(live))

      const settled = daemonSnapshot('ready')
      settled.threads[0] = { ...settled.threads[0], status: 'idle', last_error: null }
      mocks.snapshot.mockClear().mockResolvedValue(settled)

      // The first tick only starts the thread's quiet clock; the correction
      // waits until it has been silent for the full recheck window.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })
      expect(mocks.snapshot).not.toHaveBeenCalled()
      expect(result.current.snapshot?.threads[0]?.status).toBe('running')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(mocks.snapshot).toHaveBeenCalled()
      expect(result.current.snapshot?.threads[0]?.status).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a thread alone while its events keep arriving', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { result } = renderHook(() => useDaemonConnection())
      await waitFor(() => expect(result.current.connectionState).toBe('ready'))

      const live = daemonSnapshot('ready')
      live.threads[0] = { ...live.threads[0], status: 'running' }
      act(() => result.current.setSnapshot(live))
      mocks.snapshot.mockClear()

      for (let tick = 0; tick < 8; tick += 1) {
        await act(async () => {
          mocks.eventHandler?.({
            seq: 100 + tick,
            emitted_at: '2026-08-08T12:00:01Z',
            workspace_id: 'workspace-1',
            thread_id: 'thread-1',
            event: { type: 'turn-start', turn_id: `turn-${tick}` },
          } as unknown as EventEnvelope)
          await vi.advanceTimersByTimeAsync(8_000)
        })
      }
      expect(mocks.snapshot).not.toHaveBeenCalled()
      expect(result.current.snapshot?.threads[0]?.status).toBe('running')
    } finally {
      vi.useRealTimers()
    }
  })

  it('discards a dead socket frame before adopting the reconnect snapshot', async () => {
    const { result } = renderHook(() => useDaemonConnection())
    await waitFor(() => expect(result.current.connectionState).toBe('ready'))

    let queuedFrame: FrameRequestCallback | null = null
    const requestFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        queuedFrame = callback
        return 91
      })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame')
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    let reconnect: (() => void) | null = null
    const setTimeoutSpy = vi
      .spyOn(window, 'setTimeout')
      .mockImplementation((callback, delay) => {
        if (delay === 500 && typeof callback === 'function') {
          reconnect = callback as () => void
        }
        return 92
      })

    const staleThread = {
      ...daemonSnapshot('ready').threads[0],
      status: 'idle' as const,
      title: 'Stale queued status',
    }
    act(() => {
      mocks.eventHandler?.({
        seq: 4,
        emitted_at: '2026-08-08T12:00:01Z',
        workspace_id: 'workspace-1',
        thread_id: 'thread-1',
        event: { type: 'thread-updated', thread: staleThread },
      })
    })
    expect(queuedFrame).not.toBeNull()

    const freshSnapshot = daemonSnapshot('ready')
    freshSnapshot.threads[0] = {
      ...freshSnapshot.threads[0],
      status: 'running',
      title: 'Fresh reconnect status',
    }
    mocks.snapshot.mockResolvedValueOnce(freshSnapshot)

    try {
      act(() => mocks.sockets[0]?.onclose?.())
      expect(reconnect).not.toBeNull()
      setTimeoutSpy.mockRestore()
      await act(async () => {
        reconnect?.()
        await Promise.resolve()
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(result.current.snapshot?.threads[0]?.title).toBe('Fresh reconnect status'),
      )
      expect(cancelFrame).toHaveBeenCalledWith(91)

      // Even a host that dispatches an already-cancelled callback cannot
      // replay the old event because the queue was emptied with the frame.
      act(() => queuedFrame?.(performance.now()))
      expect(result.current.snapshot?.threads[0]?.title).toBe('Fresh reconnect status')
    } finally {
      setTimeoutSpy.mockRestore()
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
      random.mockRestore()
    }
  })
})
