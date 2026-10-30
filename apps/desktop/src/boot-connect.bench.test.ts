import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DaemonSnapshot, EventEnvelope, ThreadDetail } from '@falcondeck/client-core'

import { shouldQueryNewThreadGit } from './boot-schedule'
import { HostManager } from './hosts'
import { useDaemonConnection } from './hooks/useDaemonConnection'
import { useGitBranches } from './hooks/useGitBranches'

/**
 * Serialized daemon/IPC lane. Snapshot generation, git, remote status, and
 * thread detail each take the lane for a fixed slice so the bench records
 * whether boot schedules them before the first snapshot and selected detail.
 */
const DETECT_MS = 20
const SNAPSHOT_MS = 30
const GIT_MS = 40
const REMOTE_MS = 25
const DETAIL_MS = 20
const HOST_READ_MS = 35
const RUNS = 6

const bench = vi.hoisted(() => ({
  order: [] as string[],
  detailReadyAt: 0,
  startedAt: 0,
  lane: null as ReturnType<typeof createLane> | null,
}))

function createLane() {
  let chain = Promise.resolve()
  return {
    occupy<T>(name: string, ms: number, task: () => T | Promise<T>): Promise<T> {
      const run = chain.then(async () => {
        bench.order.push(name)
        await new Promise((resolve) => setTimeout(resolve, ms))
        return await task()
      })
      chain = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    },
  }
}

function readySnapshot(): DaemonSnapshot {
  return {
    daemon: {},
    preferences: {},
    workspaces: [
      {
        id: 'workspace-1',
        path: '/repo',
        status: 'ready',
        kind: 'project',
        current_thread_id: 'thread-1',
      },
    ],
    threads: [
      {
        id: 'thread-1',
        workspace_id: 'workspace-1',
        provider: 'claude',
        title: 'Restored thread',
        updated_at: '2026-08-08T12:00:00Z',
        status: 'idle',
      },
    ],
    interactive_requests: [],
  } as unknown as DaemonSnapshot
}

function readyDetail(): ThreadDetail {
  const snapshot = readySnapshot()
  return {
    workspace: snapshot.workspaces[0],
    thread: snapshot.threads[0],
    items: [{ id: 'message-1', text: 'restored' }],
    is_partial: false,
  } as unknown as ThreadDetail
}

vi.mock('./api', () => ({
  detectApiBaseUrl: () =>
    bench.lane!.occupy('detect', DETECT_MS, () => 'http://127.0.0.1:4123'),
  isTauriDesktop: () => false,
}))

vi.mock('@falcondeck/client-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@falcondeck/client-core')>()
  return {
    ...actual,
    createDaemonApiClient: () => ({
      snapshot: vi.fn(),
      remoteStatus: () =>
        bench.lane!.occupy('remoteStatus', REMOTE_MS, () => ({ status: 'inactive' })),
      threadDetail: () =>
        bench.lane!.occupy('threadDetail', DETAIL_MS, () => {
          bench.detailReadyAt = performance.now()
          return readyDetail()
        }),
      gitBranches: () =>
        bench.lane!.occupy('gitBranches', GIT_MS, () => ({
          current: 'main',
          branches: ['main'],
        })),
      gitStatus: () =>
        bench.lane!.occupy('gitStatus', GIT_MS, () => ({ branch: 'main', entries: [] })),
      gitCheckout: vi.fn(),
      connectEvents: (onEvent: (event: EventEnvelope) => void) => {
        const socket = {
          close: vi.fn(),
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
        }
        void bench.lane!.occupy('snapshot', SNAPSHOT_MS, readySnapshot).then((snapshot) => {
          onEvent({
            seq: 0,
            emitted_at: '2026-08-08T12:00:00Z',
            workspace_id: null,
            thread_id: null,
            event: { type: 'snapshot', snapshot },
          })
        })
        return socket
      },
    }),
  }
})

function useBoot() {
  const connection = useDaemonConnection()
  const workspaceKind = connection.snapshot?.workspaces.find(
    (workspace) => workspace.id === connection.selectedWorkspaceId,
  )?.kind
  const gitApi = shouldQueryNewThreadGit({
    snapshotReady: connection.snapshot !== null,
    selectedThreadId: connection.selectedThreadId,
    workspaceKind,
    remoteWorkspace: false,
    settingsOpen: false,
  })
    ? connection.api
    : null
  useGitBranches(
    gitApi as Parameters<typeof useGitBranches>[0],
    connection.selectedWorkspaceId,
    connection.gitRefreshTrigger,
  )
  return connection
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

describe('desktop boot connect bench', () => {
  afterEach(() => {
    window.localStorage.clear()
  })

  it('times the first snapshot plus selected thread detail', async () => {
    const samples: number[] = []
    const orders: string[][] = []
    for (let run = 0; run < RUNS; run += 1) {
      bench.lane = createLane()
      bench.order = []
      bench.detailReadyAt = 0
      window.localStorage.setItem(
        'falcondeck.desktop.selection',
        JSON.stringify({
          workspaceId: 'workspace-1',
          threadId: 'thread-1',
          workspacePath: '/repo',
        }),
      )
      bench.startedAt = performance.now()
      const { result, unmount } = renderHook(() => useBoot())
      try {
        await waitFor(() => expect(result.current.threadDetail?.items).toHaveLength(1), {
          timeout: 4_000,
        })
        samples.push(bench.detailReadyAt - bench.startedAt)
        orders.push([...bench.order])
      } finally {
        unmount()
        window.localStorage.clear()
      }
    }

    const detailMs = median(samples)
    console.log(
      JSON.stringify({
        metric: 'first-thread-detail-ms',
        runs: RUNS,
        samples: samples.map((value) => Math.round(value)),
        median: Math.round(detailMs),
        order: orders[orders.length - 1],
      }),
    )
    // Restored-thread boot used to be detect + snapshot + remote status + two
    // git pairs + detail (~255ms at these slices, measured median 258ms).
    // The bound stays under that schedule and above the post-change path.
    expect(detailMs).toBeLessThan(DETECT_MS + SNAPSHOT_MS + DETAIL_MS + GIT_MS + REMOTE_MS + 80)
    expect(orders[orders.length - 1]?.indexOf('threadDetail')).toBeGreaterThan(
      orders[orders.length - 1]?.indexOf('snapshot') ?? -1,
    )
    expect(orders.every((order) => !order.includes('gitBranches'))).toBe(true)
    expect(orders.every((order) => !order.includes('gitStatus'))).toBe(true)
    for (const order of orders) {
      expect(order.indexOf('threadDetail')).toBeLessThan(order.indexOf('remoteStatus'))
    }
  })
})

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

describe('stored host session hydration bench', () => {
  afterEach(() => {
    invokeMock.mockReset()
    window.localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('times credential reads before remote host sockets start', async () => {
    const secret = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
    const session = {
      version: 2,
      relayUrl: 'https://connect.falcondeck.com',
      pairingCode: 'code',
      sessionId: 'session',
      clientToken: 'token',
      clientSecretKey: secret,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    )
    const samples: number[] = []
    const spreads: number[] = []
    for (let run = 0; run < RUNS; run += 1) {
      window.localStorage.setItem(
        'falcondeck.desktop.hosts.v1',
        JSON.stringify(
          ['h1', 'h2', 'h3', 'h4'].map((id) => ({
            id,
            name: id,
            relayUrl: 'https://connect.falcondeck.com',
            enabled: true,
            hasSession: true,
          })),
        ),
      )
      const starts: number[] = []
      invokeMock.mockImplementation(async (command: string) => {
        if (command !== 'read_host_session_secret') return null
        starts.push(performance.now())
        await new Promise((resolve) => setTimeout(resolve, HOST_READ_MS))
        return JSON.stringify(session)
      })
      const manager = new HostManager()
      const started = performance.now()
      await manager.start()
      samples.push(performance.now() - started)
      spreads.push(Math.max(...starts) - Math.min(...starts))
      manager.stopAll()
      window.localStorage.clear()
    }

    const hostMs = median(samples)
    const spreadMs = median(spreads)
    console.log(
      JSON.stringify({
        metric: 'host-session-hydrate-ms',
        runs: RUNS,
        hostCount: 4,
        readMs: HOST_READ_MS,
        samples: samples.map((value) => Math.round(value)),
        median: Math.round(hostMs),
        startSpreadMs: Math.round(spreadMs),
      }),
    )
    expect(hostMs).toBeGreaterThan(HOST_READ_MS / 2)
    // Sequential reads measured median 144ms for 4 × 35ms. Overlapping reads
    // finish near one read, with start times bunched inside a single slice.
    expect(hostMs).toBeLessThan(HOST_READ_MS * 3)
    expect(spreadMs).toBeLessThan(HOST_READ_MS)
  })
})
