import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DaemonSnapshot, ThreadDetail } from '@falcondeck/client-core'

import { useDaemonConnection } from './useDaemonConnection'

const mocks = vi.hoisted(() => ({
  detectApiBaseUrl: vi.fn(),
  snapshot: vi.fn(),
  remoteStatus: vi.fn(),
  threadDetail: vi.fn(),
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
      connectEvents: () => ({
        close: vi.fn(),
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
      }),
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
  })

  it('waits for workspace hydration before fetching a restored thread detail', async () => {
    const { result } = renderHook(() => useDaemonConnection())

    await waitFor(() => expect(result.current.connectionState).toBe('ready'))
    expect(mocks.threadDetail).not.toHaveBeenCalled()

    act(() => result.current.setSnapshot(daemonSnapshot('ready')))

    await waitFor(() =>
      expect(mocks.threadDetail).toHaveBeenCalledWith('workspace-1', 'thread-1'),
    )
    await waitFor(() => expect(result.current.threadDetail?.items).toHaveLength(1))
  })
})
